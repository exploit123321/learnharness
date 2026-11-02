/**
 * The PC ↔ phone sync service (owner-approved plan, mobile sync wave).
 * Runs in the same Cloudflare Worker that serves the phone app
 * (wrangler.jsonc: only /sync/* reaches this code; everything else is the
 * static app). Storage: a D1 database Cloudflare creates on first deploy.
 *
 * It is a dumb, end-to-end-encrypted file store. Devices send opaque file
 * ids, encrypted names, encrypted contents and keyed content hashes; the
 * merge decisions (src/core/sync-merge.ts) happen on the devices. The
 * service never sees the passphrase or any plaintext.
 *
 *   GET  /sync/manifest        → { files: [{ id, name, hash, mtime, deleted, rev }] }
 *   GET  /sync/blob/:id        → the ciphertext of the current revision
 *   PUT  /sync/blob/:id?rev=N  → replace revision N (0 = new file) with the body;
 *                                headers X-LH-Name, X-LH-Hash, X-LH-Mtime,
 *                                X-LH-Deleted. 409 when someone else wrote first.
 *
 * Auth: `Authorization: Bearer <token>`, a token devices derive from the
 * passphrase. The first device to sync registers it (its SHA-256 is stored);
 * after that only the same token is accepted. To start over, delete the
 * rows of the `meta` table in the Cloudflare dashboard.
 */

/** The slice of Cloudflare's D1 API this Worker uses. */
export interface D1Like {
	prepare(sql: string): D1Statement;
	batch(statements: D1Statement[]): Promise<unknown[]>;
}
export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes: number } }>;
}

export interface Env {
	DB: D1Like;
}

/** D1 rows top out around 2 MB; ciphertext is stored in 1 MB chunks. */
const CHUNK = 1_000_000;
/** Cap one upload (a very long session with images still fits). */
const MAX_BODY = 50_000_000;

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, deleted INTEGER NOT NULL, rev INTEGER NOT NULL, gen TEXT NOT NULL)",
	// Chunks belong to one upload GENERATION (random per upload), so two
	// devices uploading the same file at once can never touch each other's
	// staged data; the file row points at the generation that won.
	"CREATE TABLE IF NOT EXISTS chunks (id TEXT NOT NULL, gen TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, gen, idx))",
];

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type, X-LH-Name, X-LH-Hash, X-LH-Mtime, X-LH-Deleted",
	"Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Schema creation, once per database binding (per isolate). */
const schemaReady = new WeakMap<D1Like, Promise<void>>();
function ensureSchema(db: D1Like): Promise<void> {
	let ready = schemaReady.get(db);
	if (!ready) {
		ready = db.batch(SCHEMA.map((s) => db.prepare(s))).then(
			() => undefined,
			(err) => {
				schemaReady.delete(db);
				throw err;
			},
		);
		schemaReady.set(db, ready);
	}
	return ready;
}

/** Trust on first use: the first valid-looking token becomes THE token. */
async function authorized(request: Request, db: D1Like): Promise<boolean> {
	const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
	if (!token) return false;
	const hashed = await sha256Hex(token);
	const row = await db.prepare("SELECT v FROM meta WHERE k = 'auth'").first<{ v: string }>();
	if (row) return sameString(row.v, hashed);
	await db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('auth', ?)").bind(hashed).run();
	const stored = await db.prepare("SELECT v FROM meta WHERE k = 'auth'").first<{ v: string }>();
	return stored !== null && sameString(stored.v, hashed);
}

const ID = /^[0-9a-f]{64}$/;

export async function handleSync(request: Request, env: Env): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	const url = new URL(request.url);
	const db = env.DB;
	if (!db) return json({ error: "The sync database is not set up (missing DB binding)." }, 500);
	await ensureSchema(db);
	if (!(await authorized(request, db))) return json({ error: "Wrong sync passphrase for this sync service." }, 401);

	if (request.method === "GET" && url.pathname === "/sync/manifest") {
		const { results } = await db.prepare("SELECT id, name, hash, mtime, deleted, rev FROM files").all<{
			id: string;
			name: string;
			hash: string;
			mtime: number;
			deleted: number;
			rev: number;
		}>();
		return json({ files: results.map((r) => ({ ...r, deleted: r.deleted === 1 })) });
	}

	const blob = /^\/sync\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
	if (!blob) return json({ error: "Not found" }, 404);
	const id = blob[1]!;
	if (!ID.test(id)) return json({ error: "Bad id" }, 400);

	if (request.method === "GET") {
		const file = await db.prepare("SELECT gen, deleted FROM files WHERE id = ?").bind(id).first<{ gen: string; deleted: number }>();
		if (!file || file.deleted === 1) return json({ error: "Not found" }, 404);
		const { results } = await db.prepare("SELECT data FROM chunks WHERE id = ? AND gen = ? ORDER BY idx").bind(id, file.gen).all<{ data: ArrayBuffer | Uint8Array | number[] }>();
		const parts = results.map((r) => (r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data as ArrayBuffer | number[])));
		const total = parts.reduce((n, p) => n + p.byteLength, 0);
		const body = new Uint8Array(total);
		let at = 0;
		for (const p of parts) {
			body.set(p, at);
			at += p.byteLength;
		}
		return new Response(body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", ...CORS } });
	}

	if (request.method === "PUT") {
		const expected = Number(url.searchParams.get("rev"));
		const name = request.headers.get("X-LH-Name") ?? "";
		const hash = request.headers.get("X-LH-Hash") ?? "";
		const mtime = Number(request.headers.get("X-LH-Mtime"));
		const deleted = request.headers.get("X-LH-Deleted") === "1";
		if (!Number.isInteger(expected) || expected < 0 || !name || !Number.isFinite(mtime) || (!deleted && !hash)) {
			return json({ error: "Bad upload" }, 400);
		}
		const body = new Uint8Array(await request.arrayBuffer());
		if (body.byteLength > MAX_BODY) return json({ error: "File too large to sync" }, 413);
		const next = expected + 1;
		const gen = crypto.randomUUID();
		// 1) Stage this upload's chunks (invisible until the row points at them).
		if (!deleted && body.byteLength > 0) {
			const staged: D1Statement[] = [];
			for (let i = 0, idx = 0; i < body.byteLength; i += CHUNK, idx++) {
				staged.push(db.prepare("INSERT INTO chunks (id, gen, idx, data) VALUES (?, ?, ?, ?)").bind(id, gen, idx, body.subarray(i, i + CHUNK)));
			}
			await db.batch(staged);
		}
		// 2) Flip the file row only if nobody else wrote since `expected`.
		const flipped =
			expected === 0
				? await db
						.prepare("INSERT OR IGNORE INTO files (id, name, hash, mtime, deleted, rev, gen) VALUES (?, ?, ?, ?, ?, 1, ?)")
						.bind(id, name, deleted ? "" : hash, mtime, deleted ? 1 : 0, gen)
						.run()
				: await db
						.prepare("UPDATE files SET name = ?, hash = ?, mtime = ?, deleted = ?, rev = ?, gen = ? WHERE id = ? AND rev = ?")
						.bind(name, deleted ? "" : hash, mtime, deleted ? 1 : 0, next, gen, id, expected)
						.run();
		if (flipped.meta.changes !== 1) {
			await db.prepare("DELETE FROM chunks WHERE id = ? AND gen = ?").bind(id, gen).run();
			return json({ error: "Changed by another device; sync again" }, 409);
		}
		// 3) Drop every older generation of this file.
		await db.prepare("DELETE FROM chunks WHERE id = ? AND gen <> ?").bind(id, gen).run();
		return json({ id, rev: next });
	}

	return json({ error: "Method not allowed" }, 405);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			return await handleSync(request, env);
		} catch (err) {
			return json({ error: `Sync service error: ${(err as Error).message}` }, 500);
		}
	},
};
