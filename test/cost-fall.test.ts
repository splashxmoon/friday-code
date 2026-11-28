import assert from "node:assert/strict";
import test from "node:test";
import { groupsOf, inOf, kindsOf, modelWords, niceCeil, replyTurn, turnsOf, turnUsd } from "../src/cost-fall.js";
import { priceFor, tokensTotal } from "../src/spend.js";
import type { SubTask } from "../src/sub-tasks.js";
import type { SessionEvent } from "../src/types.js";

/** Where a turn's, a thread's and a crew run's tokens went (cost-fall.ts), from the log alone. Demo data. */
const human = { id: "p", name: "Ada", kind: "human" as const };
const bot = { id: "engine:local", name: "Claude Code", kind: "agent" as const };
let seq = 0;
const ev = (body: SessionEvent["body"], lane: string, ts: number, actor: SessionEvent["actor"] = bot): SessionEvent => ({ seq: ++seq, ts, actor, body, lane });

function thread() {
  seq = 0;
  const t0 = Date.UTC(2026, 10, 27, 10);
  const ask1 = ev({ type: "instruction", text: "Refactor billing into invoices and payments\nkeep the API", interrupt: false, attachments: [] }, "main", t0, human);
  const events: SessionEvent[] = [
    ask1,
    ev({ type: "run.started", causedBy: ask1.seq }, "main", t0 + 1000),
    ev({ type: "agent.message", text: "", toolCalls: [{ id: "a", name: "Read", args: "{}" }, { id: "b", name: "Edit", args: "{}" }] } as never, "main", t0 + 2000),
    ev({ type: "agent.usage", tool: "claude", input: 3590, cached: 9840, output: 720, cacheWrite: 1180, reasoning: 210, context: 82_000, window: 200_000, model: "claude-opus-5-5-20261101" }, "main", t0 + 250_000),
    ev({ type: "run.ended", outcome: "done" }, "main", t0 + 252_000),
  ];
  const ask2 = ev({ type: "instruction", text: "Run the migration on dev", interrupt: false, attachments: [] }, "L2", t0 + 260_000, human);
  events.push(
    ask2,
    ev({ type: "run.started", causedBy: ask2.seq }, "L2", t0 + 261_000),
    ev({ type: "agent.usage", tool: "codex", input: 36_000, cached: 0, output: 4100, model: "gpt-5.1-codex" }, "L2", t0 + 500_000),
    ev({ type: "run.ended", outcome: "error", error: "exit 1" }, "L2", t0 + 520_000),
    ev({ type: "run.started", causedBy: 99_999 }, "L3", t0 + 530_000),
    ev({ type: "run.ended", outcome: "done" }, "L3", t0 + 598_000),
    ev({ type: "run.started", causedBy: ask1.seq }, "main", t0 + 600_000),
  );
  const subs: SubTask[] = [
    { key: "main:t1", id: "t1", lane: "main", by: "Claude Code", description: "map every caller of charge()", agentType: "Explore", status: "done", start: t0 + 5000, end: t0 + 77_000, seq: 3, opened: true, heard: t0 + 77_000 },
    { key: "main:t2", id: "t2", lane: "main", by: "Claude Code", description: "ls", agentType: "command", status: "done", start: t0 + 5000, end: t0 + 6000, seq: 3, opened: true, heard: t0 + 6000 },
    { key: "main:t3", id: "t3", lane: "main", by: "Claude Code", description: "late", status: "running", start: t0 + 601_000, seq: events.at(-1)!.seq, opened: true, heard: t0 + 601_000 },
  ];
  return { t0, events, subs };
}

test("a turn's tokens by kind: reasoning apart from the rest of the output, so the rows add up; by tokens or by price", () => {
  const { events } = thread();
  const t = turnsOf(events, {}, [], ["main"])[0]!;
  assert.deepEqual(t.tokens, { input: 2410, cacheWrite: 1180, cacheRead: 9840, output: 720, reasoning: 210 });
  const kinds = kindsOf(t.tokens!, null);
  assert.deepEqual(kinds.map((k) => k.kind), ["cacheRead", "input", "cacheWrite", "output", "reasoning"], "heaviest first");
  assert.equal(kinds.reduce((n, k) => n + k.tokens, 0), tokensTotal(t.tokens!), "the rows add up to the total");
  assert.equal(kinds.find((k) => k.kind === "output")!.tokens, 510);
  const price = priceFor("claude", t.model)!;
  const byPrice = kindsOf(t.tokens!, price, true);
  assert.equal(byPrice[0]!.kind, "output", "a few hundred output tokens cost more than ten thousand cache reads");
  assert.ok(Math.abs(byPrice.reduce((n, k) => n + (k.usd ?? 0), 0) - turnUsd(t)!) < 1e-12, "the rows' prices add up to the turn's");
  assert.equal(t.context, 82_000);
  assert.equal(t.window, 200_000);
  assert.equal(t.steps, 2);
  assert.equal(inOf(t.tokens!), 2410 + 1180 + 9840);
});

test("a thread's turns: what asked, its state, its model, subagents nested under the turn that sent them", () => {
  const { t0, events, subs } = thread();
  const turns = turnsOf(events, { L3: { tool: "cursor" }, L2: { tool: "codex", model: "auto" } }, subs);
  assert.equal(turns.length, 4);
  const [first, migrate, cursor, running] = turns;
  assert.equal(first!.ask, "Refactor billing into invoices and payments", "its first line");
  assert.equal(first!.state, "done");
  assert.deepEqual(first!.subs.map((s) => s.name), ["Explore · map every caller of charge()"], "a background command isn't a subagent; a later turn's isn't this one's");
  assert.equal(migrate!.state, "failed");
  assert.equal(migrate!.model, "gpt-5.1-codex");
  assert.equal(cursor!.tokens, null, "a tool that reported no tokens");
  assert.equal(cursor!.tool, "cursor");
  assert.equal(cursor!.ask, "", "nothing asked in words");
  assert.equal(cursor!.end! - cursor!.start, 68_000, "its time is known");
  assert.equal(running!.state, "running");
  assert.equal(running!.end, null);
  assert.deepEqual(running!.subs.map((s) => s.state), ["running"]);
  const groups = groupsOf(turns);
  assert.deepEqual(groups.map((g) => g.lane), ["main", "L2", "L3"], "in the order each first worked");
  assert.equal(groups[0]!.turns.length, 2);
  assert.equal(tokensTotal(groups[0]!.tokens), 14_150, "the running turn has reported none yet");
  assert.equal(groups[0]!.model, "claude-opus-5-5-20261101");
  assert.equal(groups[2]!.counted, false);
  assert.ok(groups[0]!.ms >= 251_000);
  assert.ok(t0 > 0);
});

test("a crew run: only its mates' lanes, from where it began", () => {
  const { events } = thread();
  const from = events.find((e) => e.body.type === "instruction" && e.lane === "L2")!.seq;
  const turns = turnsOf(events, {}, [], ["main", "L2"], from);
  assert.deepEqual(turns.map((t) => t.lane), ["L2", "main"], "main's first turn began before the run did");
});

test("a reply's turn is only its own block's usage, its run found from before it when the block starts later", () => {
  const { events } = thread();
  const started = events.find((e) => e.body.type === "run.started" && e.lane === "main")!;
  const usage = events.find((e) => e.body.type === "agent.usage" && e.lane === "main")!;
  const ended = events.find((e) => e.body.type === "run.ended" && e.lane === "main")!;
  const whole = replyTurn(events, {}, "main", started.seq, ended.seq);
  assert.equal(whole.ask, "Refactor billing into invoices and payments");
  assert.equal(tokensTotal(whole.tokens!), 14_150);
  // A block cut short and carried on: it starts after the run.started, and still knows what asked and when it began.
  const carried = replyTurn(events, {}, "main", usage.seq, ended.seq);
  assert.equal(carried.ask, "Refactor billing into invoices and payments");
  assert.equal(carried.seq, started.seq);
  const before = replyTurn(events, {}, "main", started.seq, usage.seq - 1);
  assert.equal(before.tokens, null, "no usage in its block: nothing made up");
});

test("models read as their menus name them, and the axis ends on a round figure", () => {
  assert.equal(modelWords("claude-opus-5-5-20261101"), "Opus 5.5");
  assert.equal(modelWords("opus"), "Opus 5.5");
  assert.equal(modelWords("claude-sonnet-4-6[1m]"), "Sonnet 4.6");
  assert.equal(modelWords("gpt-5.1-codex"), "GPT-5.1 Codex");
  assert.equal(modelWords(undefined), "");
  assert.equal(niceCeil(14_150), 15_000);
  assert.equal(niceCeil(186_200), 200_000);
  assert.equal(niceCeil(0.042), 0.05);
  assert.equal(niceCeil(0), 1);
});

test("a turn the log never ended is live only while its agent works, and the next turn closes it where it was last heard", () => {
  seq = 0;
  const t0 = Date.UTC(2026, 10, 27, 10);
  const events: SessionEvent[] = [
    ev({ type: "run.started", causedBy: 0 }, "main", t0),
    ev({ type: "agent.usage", tool: "claude", input: 100, cached: 0, output: 10 }, "main", t0 + 60_000),
    // A restart: no run.ended, and the next turn starts a day later.
    ev({ type: "run.started", causedBy: 0 }, "main", t0 + 86_400_000),
    ev({ type: "agent.usage", tool: "claude", input: 100, cached: 0, output: 10 }, "main", t0 + 86_430_000),
  ];
  const [first, second] = turnsOf(events, {}, [], undefined, 0, Infinity, () => false);
  assert.equal(first!.state, "done");
  assert.equal(first!.end! - first!.start, 60_000, "stopped where it was last heard, not a day of work");
  assert.equal(second!.state, "done", "left open with its agent not working: not live");
  assert.equal(turnsOf(events, {}, [], undefined, 0, Infinity, () => true).at(-1)!.state, "running", "live while its agent works");
});
