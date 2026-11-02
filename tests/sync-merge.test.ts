/**
 * PC ↔ phone sync decision rules (src/core/sync-merge.ts): what syncs,
 * who wins when one or both sides changed, and the graph-ledger line merge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decide, mergeLines, syncScope } from "../src/core/sync-merge.ts";

test("scope: sessions, practice, jobs and the graph sync; settings stay per device", () => {
	assert.equal(syncScope("chats/chat_a.json"), "newest");
	assert.equal(syncScope("practice/p1.json"), "newest");
	assert.equal(syncScope("jobs/j1.json"), "newest");
	assert.equal(syncScope("graph/nodes.jsonl"), "lines");
	assert.equal(syncScope("graph/coverage.jsonl"), "lines");
	assert.equal(syncScope("graph/positions.json"), "newest");
	assert.equal(syncScope("graph/sources.json"), "newest");
	for (const p of ["settings.json", "graph/render-settings.json", "prompts/teacher/20-teaching.md", "debug/x.jsonl", ".sync/state.json", "chats/.tmp.json", "auth.json"]) {
		assert.equal(syncScope(p), null, p);
	}
});

const at = (hash: string | null, mtime: number) => ({ hash, mtime });

test("one side changed: that side wins (writes and deletions)", () => {
	assert.deepEqual(decide(at("b", 5), at("a", 1), "a", "newest"), { kind: "push" });
	assert.deepEqual(decide(at("a", 1), at("b", 5), "a", "newest"), { kind: "pull" });
	assert.deepEqual(decide(at(null, 9), at("a", 1), "a", "newest"), { kind: "push" }, "deleted here → tombstone");
	assert.deepEqual(decide(at("a", 1), at(null, 9), "a", "newest"), { kind: "pull" }, "deleted there → delete here");
	assert.deepEqual(decide(at("n", 3), at(null, 0), null, "newest"), { kind: "push" }, "new here");
	assert.deepEqual(decide(at(null, 0), at("n", 3), null, "newest"), { kind: "pull" }, "new there");
});

test("nothing to do / already equal", () => {
	assert.deepEqual(decide(at("a", 1), at("a", 2), "a", "newest"), { kind: "none" });
	assert.deepEqual(decide(at("x", 1), at("x", 2), "a", "newest"), { kind: "adopt" });
	assert.deepEqual(decide(at(null, 1), at(null, 2), "a", "newest"), { kind: "adopt" });
});

test("both changed a session: the most recent change wins, deletions included", () => {
	assert.deepEqual(decide(at("l", 200), at("r", 100), "a", "newest"), { kind: "push" });
	assert.deepEqual(decide(at("l", 100), at("r", 200), "a", "newest"), { kind: "pull" });
	assert.deepEqual(decide(at(null, 300), at("r", 200), "a", "newest"), { kind: "push" }, "deleted here after the other edit");
	assert.deepEqual(decide(at(null, 100), at("r", 200), "a", "newest"), { kind: "pull" }, "edited there after the deletion");
});

test("both changed a graph ledger: line merge", () => {
	assert.deepEqual(decide(at("l", 1), at("r", 2), "a", "lines"), { kind: "merge-lines" });
	// A ledger deleted on one side while the other added: newest wins.
	assert.deepEqual(decide(at(null, 5), at("r", 2), "a", "lines"), { kind: "push" });
});

test("mergeLines keeps both sides' additions and both sides' deletions", () => {
	const base = "n1\nn2\nn3\n";
	const local = "n1\nn3\nL1\n"; // deleted n2, added L1
	const remote = "n1\nn2\nR1\n"; // deleted n3, added R1
	assert.equal(mergeLines(base, local, remote), "n1\nR1\nL1\n");
	assert.equal(mergeLines("", "a\n", "b\n"), "b\na\n", "first sync of two independent ledgers");
	assert.equal(mergeLines("a\n", "a\nb\n", "a\nb\n"), "a\nb\n", "same line added on both sides appears once");
	assert.equal(mergeLines("a\n", "", ""), "", "deleted on both sides");
});
