import assert from "node:assert/strict";
import { test } from "node:test";
import { activeCompaction, cutFor, summarySections } from "../src/agent/compact.js";
import { buildContext } from "../src/agent/context.js";
import type { SessionEvent } from "../src/types.js";

/** Compacting an own model's conversation (agent/compact.ts; HANDOFF-local-models-2026-11-28, phase 2). */

const ev = (seq: number, body: unknown, actor: SessionEvent["actor"] = { kind: "agent", id: "friday", name: "Friday" }): SessionEvent => ({ seq, ts: seq, actor, body }) as SessionEvent;
const human = { kind: "human" as const, id: "u", name: "Arun" };
function thread(turns: number): SessionEvent[] {
  const out: SessionEvent[] = [ev(1, { type: "instruction", text: "Recon of the lab subnet." }, human), ev(2, { type: "instructions.delivered", seqs: [1] })];
  let seq = 3;
  for (let i = 0; i < turns; i++) {
    out.push(ev(seq++, { type: "agent.message", text: `Step ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `n${i}.md` }) }] }));
    out.push(ev(seq++, { type: "tool.result", callId: `c${i}`, name: "read_file", output: `content ${i}` }));
  }
  return out;
}

test("where it cuts: before the turn that starts the last four, never inside a call and its result", () => {
  assert.equal(cutFor(thread(5), "main"), null, "too little to compact");
  const t = thread(10);
  const cut = cutFor(t, "main")!;
  const kept = t.filter((e) => e.seq > cut.upTo);
  assert.equal(kept[0]!.body.type, "agent.message", "the cut lands on an agent turn");
  assert.equal(kept.filter((e) => e.body.type === "agent.message").length, 4);
  assert.equal(cut.turns, 6);
});

test("compacted: the opening instruction, the summary, then the turns after it; undone, the whole history again", () => {
  const t = thread(10);
  const cut = cutFor(t, "main")!;
  const done = [...t, ev(100, { type: "context.compacted", before: 900, after: 200, turns: cut.turns, summary: "## Goal\nRecon.\n## Done\n- 6 files read", upTo: cut.upTo })];
  const a = activeCompaction(done, "main")!;
  assert.equal(a.upTo, cut.upTo);
  const ctx = buildContext(done, { lane: "main", compacted: { upTo: a.upTo, summary: a.summary, turns: cut.turns } });
  const texts = ctx.map((m) => (typeof m.content === "string" ? m.content : ""));
  assert.match(texts[0]!, /Recon of the lab subnet/);
  assert.ok(texts.some((x) => x.includes("6 earlier turns were compacted into this summary") && x.includes("6 files read")));
  assert.ok(!texts.some((x) => x === "Step 0"), "the compacted turns aren't sent");
  assert.ok(texts.includes("Step 9"), "the last ones are");
  // Every tool result still follows its call.
  const ids = new Set<string>();
  for (const m of ctx) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) ids.add(c.id);
    if (m.role === "tool") assert.ok(ids.has(m.tool_call_id), "no orphaned result");
  }
  const undone = [...done, ev(101, { type: "context.restored", of: 100 })];
  assert.equal(activeCompaction(undone, "main"), null);
});

test("the summary's sections, for the card", () => {
  const s = summarySections("## Goal\nRecon of the lab subnet.\n## Done\n- Port scan: 6 live hosts\n- Banner grabs on 4\n## Next\n- Service checks\n## Files\nnotes/recon.md, scans/nmap-04.txt");
  assert.deepEqual(s.map((x) => x.title), ["Goal", "Done", "Next", "Files"]);
  assert.deepEqual(s[1]!.lines, ["Port scan: 6 live hosts", "Banner grabs on 4"]);
});
