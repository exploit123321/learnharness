/**
 * PC ↔ phone sync, end to end in-process: two "devices" (two data folders)
 * sync through the real Worker code (cloud/sync-worker.ts) on a SQLite
 * stand-in for D1. Covers the owner's rules — the most recent session
 * wins, the graph merges (additions and deletions both ways) — plus
 * deletions, per-device files, busy files, encryption at rest, a wrong
 * passphrase, and the service's write-conflict guard.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { handleSync } from "../cloud/sync-worker.ts";
import { deriveSyncKeys, syncOnce, SyncHttpError, type SyncKeys } from "../src/server/sync-engine.ts";
import { fakeD1 } from "./fake-d1.ts";

const URL_BASE = "https://sync.test";

function device(name: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lh-sync-${name}-`));
	const write = (rel: string, text: string, mtime?: number) => {
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
	};
	const read = (rel: string) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf-8") : null);
	const remove = (rel: string) => fs.rmSync(path.join(dir, rel));
	return { dir, write, read, remove };
}

test("two devices converge under the owner's rules, end-to-end encrypted", async (t) => {
	const DB = fakeD1();
	const service = (input: string, init?: RequestInit) => handleSync(new Request(input, init), { DB });
	const keys = await deriveSyncKeys("correct horse battery staple");
	const pc = device("pc");
	const phone = device("phone");
	t.after(() => {
		fs.rmSync(pc.dir, { recursive: true, force: true });
		fs.rmSync(phone.dir, { recursive: true, force: true });
	});
	let clock = 1_800_000_000_000;
	const sync = (d: ReturnType<typeof device>, opts: { keys?: SyncKeys; busy?: (rel: string) => boolean } = {}) =>
		syncOnce({ dataDir: d.dir, url: URL_BASE, keys: opts.keys ?? keys, fetch: service, busy: opts.busy ?? (() => false), now: () => (clock += 1000) });

	// ── first sync: the PC uploads; per-device files stay home ────────────
	pc.write("chats/c1.json", '{"id":"c1","title":"Secret optics title"}', clock - 50_000);
	pc.write("chats/c2.json", '{"id":"c2"}', clock - 50_000);
	pc.write("graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n2"}\n');
	pc.write("settings.json", '{"models":"pc-only"}');
	pc.write("graph/render-settings.json", "{}");
	const first = await sync(pc);
	assert.deepEqual(first.pushed.sort(), ["chats/c1.json", "chats/c2.json", "graph/nodes.jsonl"]);

	const onPhone = await sync(phone);
	assert.deepEqual(onPhone.pulled.sort(), ["chats/c1.json", "chats/c2.json", "graph/nodes.jsonl"]);
	assert.equal(phone.read("chats/c1.json"), pc.read("chats/c1.json"));
	assert.equal(phone.read("settings.json"), null, "settings stay per device");
	assert.equal(phone.read("graph/render-settings.json"), null, "display settings stay per device");

	// ── encrypted at rest: no plaintext in the service's database ─────────
	const dump = JSON.stringify(
		DB.raw.prepare("SELECT f.name, f.hash, c.data FROM files f LEFT JOIN chunks c ON c.id = f.id").all(),
		(_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v),
	);
	assert.ok(!dump.includes("Secret optics title") && !dump.includes("chats/c1.json") && !dump.includes('"n1"'), "names and contents are ciphertext");

	// ── one side edits: it wins ──────────────────────────────────────────
	phone.write("chats/c1.json", '{"id":"c1","v":"phone edit"}');
	await sync(phone);
	await sync(pc);
	assert.equal(pc.read("chats/c1.json"), '{"id":"c1","v":"phone edit"}');

	// ── both edit the same session: the most recent edit wins ────────────
	pc.write("chats/c1.json", '{"id":"c1","v":"pc, earlier"}', clock + 10_000);
	phone.write("chats/c1.json", '{"id":"c1","v":"phone, later"}', clock + 20_000);
	await sync(pc); // the PC's (older) edit reaches the cloud first…
	await sync(phone); // …but the phone's later edit wins over it
	await sync(pc);
	assert.equal(pc.read("chats/c1.json"), '{"id":"c1","v":"phone, later"}');
	assert.equal(phone.read("chats/c1.json"), '{"id":"c1","v":"phone, later"}');

	// ── both change the graph: merged (adds and deletes from both) ───────
	pc.write("graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n2"}\n{"id":"pcNew"}\n');
	phone.write("graph/nodes.jsonl", '{"id":"n1"}\n{"id":"phoneNew"}\n'); // deleted n2, added one
	await sync(pc);
	const merged = await sync(phone);
	assert.deepEqual(merged.merged, ["graph/nodes.jsonl"]);
	await sync(pc);
	const expected = '{"id":"n1"}\n{"id":"pcNew"}\n{"id":"phoneNew"}\n';
	assert.equal(phone.read("graph/nodes.jsonl"), expected);
	assert.equal(pc.read("graph/nodes.jsonl"), expected);

	// ── a deleted session is deleted on the other device ─────────────────
	pc.remove("chats/c2.json");
	await sync(pc);
	const del = await sync(phone);
	assert.deepEqual(del.deletedHere, ["chats/c2.json"]);
	assert.equal(phone.read("chats/c2.json"), null);
	assert.deepEqual((await sync(pc)).pulled, [], "the tombstone does not bounce back");

	// ── a busy session (lesson running) waits, then syncs ────────────────
	pc.write("chats/c3.json", '{"id":"c3"}');
	const waiting = await sync(pc, { busy: (rel) => rel === "chats/c3.json" });
	assert.deepEqual(waiting.skipped, ["chats/c3.json"]);
	await sync(pc);
	await sync(phone);
	assert.equal(phone.read("chats/c3.json"), '{"id":"c3"}');

	// ── a different passphrase is refused ────────────────────────────────
	const stranger = device("stranger");
	t.after(() => fs.rmSync(stranger.dir, { recursive: true, force: true }));
	await assert.rejects(sync(stranger, { keys: await deriveSyncKeys("not the passphrase") }), (err: unknown) => err instanceof SyncHttpError && err.status === 401);
});

test("the service refuses a write based on a stale revision (409)", async () => {
	const DB = fakeD1();
	const keys = await deriveSyncKeys("another passphrase here");
	const call = (pathname: string, init: RequestInit = {}) =>
		handleSync(new Request(`${URL_BASE}${pathname}`, { ...init, headers: { Authorization: `Bearer ${keys.token}`, ...(init.headers ?? {}) } }), { DB });
	const id = "a".repeat(64);
	const put = (rev: number, body: string) =>
		call(`/sync/blob/${id}?rev=${rev}`, { method: "PUT", headers: { "X-LH-Name": "bmFtZQ==", "X-LH-Hash": "h", "X-LH-Mtime": "1", "X-LH-Deleted": "0" }, body });
	assert.equal((await put(0, "first")).status, 200);
	assert.equal((await put(0, "second, stale")).status, 409, "a second 'new file' upload loses");
	assert.equal(await (await call(`/sync/blob/${id}`)).text(), "first", "the losing upload left no trace");
	assert.equal((await put(1, "update")).status, 200);
	assert.equal(await (await call(`/sync/blob/${id}`)).text(), "update");
	const chunks = DB.raw.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
	assert.equal(chunks.n, 1, "superseded generations are dropped");
});
