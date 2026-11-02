/**
 * PC ↔ phone sync — the app side (owner-approved plan, mobile sync wave).
 * The same module runs in the desktop server and, unchanged, in the
 * phone's on-device backend. One pass is src/server/sync-engine.ts; this
 * file owns the configuration, the triggers and the status:
 *
 * - config  <data>/.sync/config.json  { url }                (per device)
 * - keys    <data>/.sync/keys.json    derived from the passphrase; the
 *           passphrase itself is never stored (mode 0600 on desktop)
 * - state   <data>/.sync/state.json   (the engine's base)
 *
 * None of it syncs (dot-folder) or goes into phone backups.
 *
 * Triggers (owner): app start, after every settled turn, every 5 minutes,
 * the phone returning to the foreground (it POSTs /api/sync), and Sync now.
 * Passes never overlap; a request during a pass schedules one more.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit, subscribe } from "../core/events.ts";
import type { SyncStatus } from "../core/contracts/sync.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { compactionInFlight } from "./compaction.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { deriveSyncKeys, syncOnce, SyncHttpError, type SyncKeys, type SyncResult } from "./sync-engine.ts";

const DIR = () => path.join(PATHS.data, ".sync");
const CONFIG = () => path.join(DIR(), "config.json");
const KEYS = () => path.join(DIR(), "keys.json");
const INTERVAL_MS = 5 * 60_000;

type Config = { url: string };

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8") as string) as T;
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown, mode?: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), mode === undefined ? undefined : { mode });
	if (mode !== undefined) {
		try {
			fs.chmodSync(file, mode);
		} catch {
			// best effort (the phone's file system has no modes)
		}
	}
}

function loadKeys(): SyncKeys | null {
	const raw = readJson<{ enc: string; mac: string; token: string }>(KEYS());
	if (!raw) return null;
	return { enc: new Uint8Array(Buffer.from(raw.enc, "base64")), mac: new Uint8Array(Buffer.from(raw.mac, "base64")), token: raw.token };
}

/** Normalize the sync address: https (http only for local testing). */
export function normalizeSyncUrl(input: string): string | null {
	try {
		const url = new URL(input.trim());
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
		if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
		return url.origin;
	} catch {
		return null;
	}
}

// ─── The pass, single-flight ─────────────────────────────────────────────────

/** Leave a file alone while something on this device is writing it. */
function busy(rel: string): boolean {
	const chat = /^chats\/([^/]+)\.json$/.exec(rel);
	if (chat) return isTurnRunning(chat[1]!) || compactionInFlight(chat[1]!);
	if (rel.startsWith("graph/")) return extractionStatuses().length > 0;
	return false;
}

const status: { running: boolean; lastError: string | null; lastResult: SyncResult | null; lastAttemptAt: number | null } = {
	running: false,
	lastError: null,
	lastResult: null,
	lastAttemptAt: null,
};
let inFlight: Promise<void> | null = null;
let again = false;

function announce(result: SyncResult): void {
	const touched = [...result.pulled, ...result.merged, ...result.deletedHere];
	const chats = new Set<string>();
	let graph = false;
	let jobs = false;
	for (const rel of touched) {
		const chat = /^chats\/([^/]+)\.json$/.exec(rel);
		if (chat) chats.add(chat[1]!);
		else if (rel.startsWith("graph/")) graph = true;
		else if (rel.startsWith("jobs/")) jobs = true;
	}
	for (const chatId of chats) emit("record-changed", { chatId });
	if (chats.size > 0) emit("chats-changed", {});
	if (graph) emit("graph-changed", {});
	if (jobs) emit("jobs-changed", {});
}

async function runPass(url: string, keys: SyncKeys): Promise<void> {
	status.running = true;
	status.lastAttemptAt = Date.now();
	try {
		// Two tries: a 409 means another device wrote mid-pass; the second
		// pass sees its change and converges.
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await syncOnce({ dataDir: PATHS.data, url, keys, fetch: (i, init) => fetch(i, init), busy });
			status.lastResult = result;
			const moved = { sent: result.pushed, received: result.pulled, merged: result.merged, deleted: result.deletedHere, waiting: result.skipped };
			if (Object.values(moved).some((list) => list.length > 0)) console.info("[sync] pass:", JSON.stringify(moved));
			announce(result);
			if (!result.conflicted) break;
		}
		status.lastError = null;
	} catch (err) {
		status.lastError = err instanceof SyncHttpError && err.status === 401 ? "Wrong passphrase for this sync address." : (err as Error).message;
		console.error("[sync] pass failed:", err);
	} finally {
		status.running = false;
	}
}

/** Run a pass now (or right after the running one). Resolves when done. */
export async function syncNow(): Promise<SyncStatus> {
	const config = readJson<Config>(CONFIG());
	const keys = loadKeys();
	if (!config || !keys) return syncStatus();
	if (inFlight) {
		again = true;
		await inFlight;
		return syncStatus();
	}
	inFlight = (async () => {
		do {
			again = false;
			await runPass(config.url, keys);
		} while (again);
	})().finally(() => {
		inFlight = null;
	});
	await inFlight;
	return syncStatus();
}

export function syncStatus(): SyncStatus {
	const config = readJson<Config>(CONFIG());
	const state = readJson<{ lastSyncAt?: number }>(path.join(DIR(), "state.json"));
	const r = status.lastResult;
	return {
		configured: config !== null && fs.existsSync(KEYS()),
		url: config?.url ?? null,
		running: status.running,
		lastSyncAt: state?.lastSyncAt ?? null,
		lastError: status.lastError,
		lastChanges: r ? { sent: r.pushed.length, received: r.pulled.length + r.merged.length + r.deletedHere.length, waiting: r.skipped.length } : null,
	};
}

/** Turn sync on: derive the keys, check them against the service with a
 *  first pass, and keep them only if it worked. */
export async function enableSync(urlInput: string, passphrase: string): Promise<{ ok: true; status: SyncStatus } | { ok: false; error: string }> {
	const url = normalizeSyncUrl(urlInput);
	if (!url) return { ok: false, error: "The sync address must start with https://" };
	if (passphrase.trim().length < 8) return { ok: false, error: "Use a passphrase of at least 8 characters (longer is safer)." };
	const keys = await deriveSyncKeys(passphrase);
	try {
		const res = await fetch(`${url}/sync/manifest`, { cache: "no-store", headers: { Authorization: `Bearer ${keys.token}` } });
		if (res.status === 401) return { ok: false, error: "Wrong passphrase for this sync address." };
		if (!res.ok) return { ok: false, error: `The sync address answered HTTP ${res.status}. Is it your LearnHarness Cloudflare address?` };
	} catch (err) {
		return { ok: false, error: `Could not reach the sync address: ${(err as Error).message}` };
	}
	writeJson(CONFIG(), { url } satisfies Config);
	writeJson(KEYS(), { enc: Buffer.from(keys.enc).toString("base64"), mac: Buffer.from(keys.mac).toString("base64"), token: keys.token }, 0o600);
	return { ok: true, status: await syncNow() };
}

/** Turn sync off on this device (the cloud copy and other devices are untouched). */
export function disableSync(): SyncStatus {
	fs.rmSync(DIR(), { recursive: true, force: true });
	status.lastError = null;
	status.lastResult = null;
	return syncStatus();
}

// ─── Triggers ────────────────────────────────────────────────────────────────

type SyncGlobal = { __lhSyncStarted?: boolean };

/** Start the automatic triggers once per process (desktop server, phone
 *  page). Inert until sync is configured; never in tests. */
function startTriggers(): void {
	const g = globalThis as SyncGlobal;
	if (g.__lhSyncStarted || process.env.NODE_ENV === "test") return;
	g.__lhSyncStarted = true;
	const kick = () => {
		if (fs.existsSync(CONFIG())) void syncNow();
	};
	const unref = (t: ReturnType<typeof setTimeout>) => (t as { unref?: () => void }).unref?.();
	unref(setTimeout(kick, 3_000));
	unref(setInterval(kick, INTERVAL_MS));
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	subscribe((event) => {
		if (event.type !== "turn-settled") return;
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(kick, 2_000);
		unref(settleTimer);
	});
}

startTriggers();
