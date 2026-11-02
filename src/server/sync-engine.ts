/**
 * One PC ↔ phone sync pass (owner-approved plan, mobile sync wave). Runs
 * on both apps — the phone runs this same server code in its page — over
 * the data folder, with everything external injected (folder, network,
 * busy checks, keys) so tests can run two "devices" side by side.
 *
 * End-to-end encrypted: file ids and content hashes are keyed HMACs, file
 * names and contents are AES-GCM ciphertext. The service
 * (cloud/sync-worker.ts) stores only those. Decisions per file come from
 * src/core/sync-merge.ts against the BASE this device recorded at its last
 * successful sync (`<data>/.sync/state.json`, plus base copies of the
 * graph ledgers in `<data>/.sync/base/` for the 3-way line merge).
 *
 * ARCHITECTURE NOTE (owner-approved exception): sync writes data files
 * directly, below the store ports — a second writer next to each store.
 * It is guarded: a session with a turn or compaction running, and the
 * graph while an extraction runs, are skipped and retried next pass;
 * writes are atomic (temp file + rename).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { decide, mergeLines, syncScope, type SyncSide } from "../core/sync-merge.ts";

// ─── Keys ────────────────────────────────────────────────────────────────────

export interface SyncKeys {
	/** AES-GCM key bytes (32). */
	enc: Uint8Array;
	/** HMAC key bytes (32) for file ids and content hashes. */
	mac: Uint8Array;
	/** Hex token the service checks (it stores only its SHA-256). */
	token: string;
}

const KDF_ITERATIONS = 210_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Derive the three keys from the passphrase. Deterministic: every device
 *  with the same passphrase derives the same keys. */
export async function deriveSyncKeys(passphrase: string): Promise<SyncKeys> {
	const base = await subtle().importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
	const bits = async (purpose: string) =>
		new Uint8Array(
			await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(`learnharness-sync-v1:${purpose}`), iterations: KDF_ITERATIONS }, base, 256),
		);
	const [encKey, macKey, token] = await Promise.all([bits("encrypt"), bits("mac"), bits("auth")]);
	return { enc: encKey, mac: macKey, token: hex(token) };
}

async function hmacHex(keys: SyncKeys, label: string, data: Uint8Array): Promise<string> {
	const key = await subtle().importKey("raw", keys.mac as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const msg = new Uint8Array(label.length + 1 + data.byteLength);
	msg.set(enc.encode(`${label}:`), 0);
	msg.set(data, label.length + 1);
	return hex(new Uint8Array(await subtle().sign("HMAC", key, msg as BufferSource)));
}

async function aes(keys: SyncKeys): Promise<CryptoKey> {
	return subtle().importKey("raw", keys.enc as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptBytes(keys: SyncKeys, plain: Uint8Array): Promise<Uint8Array> {
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
	const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, await aes(keys), plain as BufferSource));
	const out = new Uint8Array(12 + sealed.byteLength);
	out.set(iv, 0);
	out.set(sealed, 12);
	return out;
}

export async function decryptBytes(keys: SyncKeys, sealed: Uint8Array): Promise<Uint8Array> {
	if (sealed.byteLength < 28) throw new Error("Corrupt sync data");
	const plain = await subtle().decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) as BufferSource }, await aes(keys), sealed.subarray(12) as BufferSource);
	return new Uint8Array(plain);
}

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

// ─── Local state ─────────────────────────────────────────────────────────────

/** Per file: what both sides agreed on at the last successful sync, plus a
 *  hash cache keyed by the local file's mtime+size (skips re-hashing). */
export interface SyncState {
	base: Record<string, { hash: string; rev: number }>;
	cache: Record<string, { mtime: number; size: number; hash: string }>;
	lastSyncAt?: number;
}

const STATE_DIR = ".sync";

function readState(dataDir: string): SyncState {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_DIR, "state.json"), "utf-8")) as Partial<SyncState>;
		return { base: parsed.base ?? {}, cache: parsed.cache ?? {}, lastSyncAt: parsed.lastSyncAt };
	} catch {
		return { base: {}, cache: {} };
	}
}

function writeAtomic(file: string, data: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.lhsync-tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function writeState(dataDir: string, state: SyncState): void {
	writeAtomic(path.join(dataDir, STATE_DIR, "state.json"), JSON.stringify(state));
}

const baseCopy = (dataDir: string, rel: string) => path.join(dataDir, STATE_DIR, "base", rel);

/** Every synced file under the data folder, POSIX-relative. */
function scan(dataDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[];
		} catch {
			return;
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!e.name.startsWith(".")) walk(path.join(dir, e.name), childRel);
			} else if (syncScope(childRel)) out.push(childRel);
		}
	};
	walk(dataDir, "");
	return out;
}

// ─── The pass ────────────────────────────────────────────────────────────────

interface RemoteEntry {
	id: string;
	path: string;
	hash: string | null;
	mtime: number;
	rev: number;
}

export interface SyncDeps {
	dataDir: string;
	/** The sync service's base URL (the Worker that serves the phone app). */
	url: string;
	keys: SyncKeys;
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	/** True = leave this file alone this pass (a turn/extraction is writing it). */
	busy: (rel: string) => boolean;
	now?: () => number;
}

export interface SyncResult {
	pushed: string[];
	pulled: string[];
	merged: string[];
	deletedHere: string[];
	skipped: string[];
	/** Another device wrote during this pass; run again to converge. */
	conflicted: boolean;
}

export class SyncHttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
	const { dataDir, keys } = deps;
	const now = deps.now ?? Date.now;
	const base = deps.url.replace(/\/+$/, "");
	const auth = { Authorization: `Bearer ${keys.token}` };
	const call = async (pathname: string, init: RequestInit = {}) => {
		// no-store: a sync request must never be answered from any cache.
		const res = await deps.fetch(`${base}${pathname}`, { cache: "no-store", ...init, headers: { ...auth, ...(init.headers ?? {}) } });
		if (!res.ok && res.status !== 409) {
			const detail = await res.json().then((b: { error?: string }) => b.error, () => undefined);
			throw new SyncHttpError(res.status, detail ?? `Sync service answered HTTP ${res.status}`);
		}
		return res;
	};

	const state = readState(dataDir);
	const result: SyncResult = { pushed: [], pulled: [], merged: [], deletedHere: [], skipped: [], conflicted: false };

	// Remote manifest, names decrypted.
	const manifest = (await (await call("/sync/manifest")).json()) as {
		files: { id: string; name: string; hash: string; mtime: number; deleted: boolean; rev: number }[];
	};
	const remote = new Map<string, RemoteEntry>();
	for (const f of manifest.files) {
		let rel: string;
		try {
			rel = dec.decode(await decryptBytes(keys, fromB64(f.name)));
		} catch {
			throw new SyncHttpError(401, "This sync service holds data from a different passphrase");
		}
		remote.set(rel, { id: f.id, path: rel, hash: f.deleted ? null : f.hash, mtime: f.mtime, rev: f.rev });
	}

	// Local files, hashed (cached by mtime+size).
	const local = new Map<string, SyncSide>();
	for (const rel of scan(dataDir)) {
		const file = path.join(dataDir, rel);
		const st = fs.statSync(file);
		const cached = state.cache[rel];
		let hash: string;
		if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) hash = cached.hash;
		else {
			hash = await hmacHex(keys, "content", new Uint8Array(fs.readFileSync(file) as Uint8Array));
			state.cache[rel] = { mtime: st.mtimeMs, size: st.size, hash };
		}
		local.set(rel, { hash, mtime: st.mtimeMs });
	}

	const fileId = (rel: string) => remote.get(rel)?.id ?? hmacHex(keys, "path", enc.encode(rel));
	const readLocal = (rel: string) => new Uint8Array(fs.readFileSync(path.join(dataDir, rel)) as Uint8Array);
	const recordLocal = (rel: string, hash: string) => {
		const st = fs.statSync(path.join(dataDir, rel));
		state.cache[rel] = { mtime: st.mtimeMs, size: st.size, hash };
	};

	const upload = async (rel: string, plain: Uint8Array | null, hash: string, mtime: number): Promise<number | null> => {
		const id = await fileId(rel);
		const rev = remote.get(rel)?.rev ?? 0;
		const res = await call(`/sync/blob/${id}?rev=${rev}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-LH-Name": toB64(await encryptBytes(keys, enc.encode(rel))),
				"X-LH-Hash": hash,
				"X-LH-Mtime": String(Math.round(mtime)),
				"X-LH-Deleted": plain ? "0" : "1",
			},
			body: plain ? ((await encryptBytes(keys, plain)) as BodyInit) : new Uint8Array(0),
		});
		if (res.status === 409) {
			result.conflicted = true;
			return null;
		}
		return ((await res.json()) as { rev: number }).rev;
	};

	const download = async (entry: RemoteEntry): Promise<Uint8Array> => {
		const res = await call(`/sync/blob/${entry.id}`);
		const plain = await decryptBytes(keys, new Uint8Array(await res.arrayBuffer()));
		if ((await hmacHex(keys, "content", plain)) !== entry.hash) throw new Error(`Sync copy of ${entry.path} failed its integrity check`);
		return plain;
	};

	const keepBaseCopy = (rel: string, plain: Uint8Array | null) => {
		if (syncScope(rel) !== "lines") return;
		if (plain) writeAtomic(baseCopy(dataDir, rel), plain);
		else fs.rmSync(baseCopy(dataDir, rel), { force: true });
	};

	const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(state.base)]);
	for (const rel of [...paths].sort()) {
		const scope = syncScope(rel);
		if (!scope) continue;
		if (deps.busy(rel)) {
			result.skipped.push(rel);
			continue;
		}
		const l = local.get(rel) ?? { hash: null, mtime: now() };
		const r = remote.get(rel);
		const rs: SyncSide = r ? { hash: r.hash, mtime: r.mtime } : { hash: null, mtime: 0 };
		const action = decide(l, rs, state.base[rel]?.hash ?? null, scope);

		if (action.kind === "none") continue;

		if (action.kind === "adopt") {
			if (l.hash === null) delete state.base[rel];
			else {
				state.base[rel] = { hash: l.hash, rev: r?.rev ?? 0 };
				keepBaseCopy(rel, readLocal(rel));
			}
			continue;
		}

		if (action.kind === "push") {
			if (l.hash === null && rs.hash === null) {
				delete state.base[rel];
				continue;
			}
			const plain = l.hash === null ? null : readLocal(rel);
			const rev = await upload(rel, plain, l.hash ?? "", l.mtime);
			if (rev === null) continue;
			if (l.hash === null) delete state.base[rel];
			else state.base[rel] = { hash: l.hash, rev };
			keepBaseCopy(rel, plain);
			result.pushed.push(rel);
			continue;
		}

		if (action.kind === "pull") {
			const file = path.join(dataDir, rel);
			if (rs.hash === null) {
				fs.rmSync(file, { force: true });
				delete state.base[rel];
				delete state.cache[rel];
				keepBaseCopy(rel, null);
				result.deletedHere.push(rel);
			} else {
				const plain = await download(r!);
				writeAtomic(file, plain);
				recordLocal(rel, rs.hash);
				state.base[rel] = { hash: rs.hash, rev: r!.rev };
				keepBaseCopy(rel, plain);
				result.pulled.push(rel);
			}
			continue;
		}

		// merge-lines: both sides changed a graph ledger.
		let baseText = "";
		try {
			baseText = fs.readFileSync(baseCopy(dataDir, rel), "utf-8") as string;
		} catch {
			// no base copy yet (first sync): the merge treats everything as added
		}
		const remoteText = dec.decode(await download(r!));
		const merged = enc.encode(mergeLines(baseText, dec.decode(readLocal(rel)), remoteText));
		writeAtomic(path.join(dataDir, rel), merged);
		const hash = await hmacHex(keys, "content", merged);
		recordLocal(rel, hash);
		const rev = await upload(rel, merged, hash, now());
		if (rev === null) continue; // base stays → next pass merges again
		state.base[rel] = { hash, rev };
		keepBaseCopy(rel, merged);
		result.merged.push(rel);
	}

	// Forget cache entries for files that are gone.
	for (const rel of Object.keys(state.cache)) if (!local.has(rel) && !fs.existsSync(path.join(dataDir, rel))) delete state.cache[rel];
	state.lastSyncAt = now();
	writeState(dataDir, state);
	return result;
}
