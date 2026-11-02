/**
 * PC ↔ phone sync — the pure decision rules (owner-approved plan, mobile
 * sync wave). Each device keeps, per synced file, the state both sides
 * agreed on at the last successful sync (the BASE). Comparing the local
 * file and the cloud copy against that base tells who changed what:
 *
 * - only one side changed → that side's version wins (including deletes);
 * - both changed:
 *     · graph ledgers (append-only JSONL): a 3-way LINE merge — additions
 *       from both sides are kept, deletions from either side apply (owner:
 *       "graph merged");
 *     · everything else: the most recently modified copy wins (owner:
 *       "recent session wins"); a deletion counts as a modification at the
 *       time it was noticed.
 *
 * What syncs at all is decided by syncScope (owner: settings, keys,
 * prompt overrides and display settings stay per device). No IO here.
 */

/** A file as one side sees it. `hash` identifies content; null = absent. */
export interface SyncSide {
	hash: string | null;
	/** Last modification time (ms). For a deletion: when it happened/was noticed. */
	mtime: number;
}

export type SyncAction =
	| { kind: "none" }
	| { kind: "push" } // local → cloud (upload, or a tombstone when local.hash is null)
	| { kind: "pull" } // cloud → local (write, or delete when remote.hash is null)
	| { kind: "merge-lines" } // both changed a ledger: 3-way line merge, then write + push
	| { kind: "adopt" }; // both sides already equal: just record the base

/** Paths are POSIX, relative to the data folder ("chats/chat_x.json"). */
export function syncScope(path: string): "lines" | "newest" | null {
	if (path.startsWith(".") || path.includes("/.")) return null; // .sync/ state, dotfiles
	if (/^graph\/[^/]+\.jsonl$/.test(path)) return "lines";
	if (/^chats\/[^/]+\.json$/.test(path)) return "newest";
	if (/^(jobs|practice)\/[^/]+\.json$/.test(path)) return "newest";
	if (path === "graph/positions.json" || path === "graph/sources.json" || path === "graph/format.json") return "newest";
	// Per device: settings.json, prompts/, graph/render-settings.json,
	// debug/, auth (outside the data folder anyway), anything unknown.
	return null;
}

export function decide(local: SyncSide, remote: SyncSide, base: string | null, scope: "lines" | "newest"): SyncAction {
	if (local.hash === remote.hash) return local.hash === base ? { kind: "none" } : { kind: "adopt" };
	const localChanged = local.hash !== base;
	const remoteChanged = remote.hash !== base;
	if (localChanged && !remoteChanged) return { kind: "push" };
	if (remoteChanged && !localChanged) return { kind: "pull" };
	// Both changed.
	if (scope === "lines" && local.hash !== null && remote.hash !== null) return { kind: "merge-lines" };
	return local.mtime >= remote.mtime ? { kind: "push" } : { kind: "pull" };
}

function lines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * 3-way merge of append-only line files. Keeps the cloud copy's order,
 * drops lines this device deleted since the base, then appends lines this
 * device added that the cloud copy doesn't have yet.
 */
export function mergeLines(base: string, local: string, remote: string): string {
	const baseSet = new Set(lines(base));
	const localSet = new Set(lines(local));
	const remoteLines = lines(remote);
	const remoteSet = new Set(remoteLines);
	const kept = remoteLines.filter((l) => !(baseSet.has(l) && !localSet.has(l)));
	const added = lines(local).filter((l) => !baseSet.has(l) && !remoteSet.has(l));
	const out = [...kept, ...added];
	return out.length > 0 ? `${out.join("\n")}\n` : "";
}
