import assert from "node:assert/strict";
import test from "node:test";
import { editsOf, shortPath } from "../src/thread-edits.js";
import type { SessionEvent } from "../src/types.js";

const msg = (seq: number, ts: number, calls: { id: string; args: unknown }[]): SessionEvent =>
  ({ seq, ts, actor: { kind: "agent", id: "a" }, body: { type: "agent.message", text: "", toolCalls: calls.map((c) => ({ id: c.id, name: "Edit", arguments: JSON.stringify(c.args) })) } }) as unknown as SessionEvent;
const result = (seq: number, callId: string, isError: boolean): SessionEvent =>
  ({ seq, ts: 0, actor: { kind: "agent", id: "a" }, body: { type: "tool.result", callId, name: "Edit", output: "", isError } }) as unknown as SessionEvent;

test("a thread's edits, timed from the first, with counts and a few lines", () => {
  const evs = [
    msg(1, 10_000, [{ id: "c1", args: { file_path: "/p/app/page.tsx", content: "a\nb\nc" } }]),
    msg(2, 40_000, [{ id: "c2", args: { file_path: "/p/lib/brand.ts", old_string: "x\ny", new_string: "x\nz\nw" } }]),
    msg(3, 50_000, [{ id: "c3", args: { command: "ls" } }]),
  ];
  const { start, edits } = editsOf(evs, "/p");
  assert.equal(start, 10_000);
  assert.deepEqual(edits.map((e) => [e.at, e.file, e.added, e.removed]), [
    [0, "app/page.tsx", 3, 0],
    [30, "lib/brand.ts", 2, 1],
  ]);
  assert.deepEqual(edits[1]!.diff, ["-y", "+z", "+w"]);
});

test("a failed edit isn't counted, and nothing edited is no start", () => {
  const evs = [msg(1, 1000, [{ id: "c1", args: { file_path: "/p/a.ts", content: "a" } }]), result(2, "c1", true)];
  assert.deepEqual(editsOf(evs, "/p"), { start: null, edits: [] });
});

test("paths outside the folder stay whole", () => {
  assert.equal(shortPath("/q/a.ts", "/p"), "/q/a.ts");
  assert.equal(shortPath("C:\\p\\src\\a.ts", "C:\\p\\"), "src/a.ts");
});

test("a Captain's agent's edits in its copy read as the project's, /private/var and /var as one folder", () => {
  const roots = ["/var/folders/x/app", "/var/folders/x/worktrees/app-e22a77b5"];
  assert.equal(shortPath("/private/var/folders/x/worktrees/app-e22a77b5/NOTES.md", roots), "NOTES.md");
  assert.equal(shortPath("/var/folders/x/app/src/a.ts", roots), "src/a.ts");
  assert.equal(shortPath("/elsewhere/b.ts", roots), "/elsewhere/b.ts");
  assert.equal(shortPath("/p/a.ts", "/p"), "a.ts");
});

test("Codex's edits: one call for several files, each counted from its diff, a new file from its content (Arun, 2026-11-28)", () => {
  const changes = [
    { path: "/copy/src/a.ts", kind: { type: "update" }, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+more\n" },
    { path: "/copy/src/b.ts", kind: "add", diff: "one\ntwo\n" },
    { path: "/copy/src/c.ts", kind: { type: "delete" }, diff: "gone\nalso\nthird\n" },
  ];
  const { edits } = editsOf([msg(1, 5000, [{ id: "c1", args: { path: changes.map((c) => c.path).join(", "), changes } }])], ["/p", "/copy"]);
  assert.deepEqual(edits.map((e) => [e.file, e.added, e.removed]), [["src/a.ts", 2, 1], ["src/b.ts", 2, 0], ["src/c.ts", 0, 3]]);
  assert.deepEqual(edits[0]!.diff, ["-old", "+new", "+more"]);
});
