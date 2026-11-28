// The agent pictures' adapters (src/client/components/agent-viz/adapters.ts): what a Captain, a session and a crew workflow's runs
// become in Agent Crew, Agent Fleet, Agent Monitor and Agent Handoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captainCrew, captainFleet, hubMonitor, sessionCrews, stepKind, threadMonitor, workflowRelay, type CaptainLike, type Marks } from "../src/client/components/agent-viz/adapters.js";
import type { RoomRun } from "../src/team-workflow-model.js";

const marks: Marks = { engine: (t) => `engine:${t}`, step: (k) => `step:${k}`, face: (s) => `face:${s}` };
const names = { claude: "Claude Code", codex: "Codex" };
const NOW = Date.parse("2026-11-27T12:00:00");

const captain = (over: Partial<CaptainLike> = {}): CaptainLike => ({
  id: "c",
  look: "edge",
  on: true,
  project: { name: "Friday web" },
  tool: "claude",
  model: "sonnet",
  goals: [
    { id: "g", title: "Faster checkout", ask: "x", at: NOW - 3_600_000, status: "working", threads: [{ sid: "a", task: "profile it", state: "ready" }, { sid: "b", task: "lazy-load the form", state: "running", stage: 1 }] },
  ],
  queue: [{ id: "q", text: "measure again", goal: "g", stage: 2 }],
  log: [
    { at: NOW - 900_000, kind: "started", text: "Started “lazy-load the form”", sid: "b" },
    { at: NOW - 300_000, kind: "said", text: "The form loads after the page draws", sid: "b" },
  ],
  threads: [
    { sid: "a", title: "Profile it", state: "idle", since: NOW - 2_000_000, tool: "claude" },
    { sid: "b", title: "Lazy-load the form", state: "working", since: NOW - 900_000, tool: "codex" },
  ],
  ready: [{ sid: "a", facts: "Checked · 3 tests pass", summary: ["The price table is read twice."] }],
  spend: { day: new Date(NOW).toLocaleDateString("en-CA"), usd: 0.4, context: 18_000, window: 200_000 },
  ...over,
});

test("a Captain's crew: the Captain over its goal's threads, then what's queued, each handed its task", () => {
  const { lead, title, projects } = captainCrew(captain(), { now: NOW, marks, names });
  assert.equal(title, "Faster checkout");
  assert.deepEqual(projects, [{ id: "g", name: "Faster checkout", working: 1 }]);
  assert.equal(lead.status, "working");
  assert.deepEqual(lead.context, { used: 18_000, max: 200_000 });
  assert.deepEqual(lead.children!.map((k) => [k.name, k.status]), [["Profile it", "done"], ["Lazy-load the form", "working"], ["Measure again", "queued"]]);
  const b = lead.children![1]!;
  assert.equal(b.doing, "The form loads after the page draws");
  assert.deepEqual(b.handed, { from: "Captain", text: "lazy-load the form", at: NOW - 900_000 });
  assert.equal(lead.children![0]!.doing, "The price table is read twice.");
});

test("a Captain waiting on you says so, and yesterday's spend isn't today's", () => {
  const c = captain({ threads: [{ sid: "a", title: "Profile it", state: "needs", since: NOW, tool: "claude" }], spend: { day: "2026-11-26", usd: 9 } });
  const { lead } = captainCrew(c, { now: NOW, marks, names });
  assert.equal(lead.status, "needs");
  assert.equal(lead.context, undefined);
  const [f] = captainFleet([c], { now: NOW, marks, names });
  assert.equal(f!.cost, undefined);
});

test("Captains as a fleet: each sums up its threads, with today's spend and how long its oldest thread has run", () => {
  const [f] = captainFleet([captain()], { now: NOW, marks, names });
  assert.equal(f!.cost, 0.4);
  assert.equal(f!.ms, 900_000);
  assert.deepEqual(f!.subs.map((s) => [s.name, s.status, s.task]), [["Profile it", "idle", "Profile it"], ["Lazy-load the form", "working", "Lazy-load the form"]]);
});

test("a thread's monitor: the Captain's steps on it, newest first, each timed to the next", () => {
  const c = captain();
  const mon = threadMonitor(c, { ...c.threads![1]!, ask: undefined }, { now: NOW, marks, names, progress: { done: 1, of: 3 } });
  assert.equal(mon.status, "working");
  assert.deepEqual(mon.steps.map((s) => [s.text, s.ms, s.tool.id]), [["The form loads after the page draws", 300_000, "say"], ["Started “lazy-load the form”", 600_000, "start"]]);
  assert.deepEqual(mon.progress, { done: 1, total: 3 });
  const asking = threadMonitor(c, { sid: "x", title: "tidy", state: "needs", since: NOW - 1000, tool: "claude", ask: "npm publish" }, { now: NOW, marks, names });
  assert.equal(asking.ask?.command, "npm publish");
  assert.equal(asking.ask?.onAllow, undefined, "answered in the thread, not from here");
});

test("a session agent's monitor: its finished steps by kind, its command waiting on you", () => {
  const a = { lane: "main", name: "Claude Code", tool: "claude" as const, status: "working" as const, line: "Running npm test", plan: { done: 2, total: 5 }, startedAt: NOW - 90_000, endedAt: null, model: "opus", branch: "ada/x", ask: null, needsYou: false };
  const m = hubMonitor(a, [{ lane: "main", text: "Edited streaks.ts", ts: NOW - 20_000, failed: false }, { lane: "main", text: "Read streaks.test.ts", ts: NOW - 45_000, failed: false }, { lane: "other", text: "Ran ls", ts: NOW, failed: false }], { now: NOW, marks, names });
  assert.deepEqual(m.steps.map((s) => [s.text, s.ms, s.tool.id]), [["Edited streaks.ts", 25_000, "edit"], ["Read streaks.test.ts", 45_000, "read"]]);
  assert.equal(m.current?.since, NOW - 20_000);
  assert.equal(m.current?.tool.id, "run");
  const asks = hubMonitor({ ...a, ask: { id: "1", items: ["rm -rf build"], scope: "commands" } }, [], { now: NOW, marks, names });
  assert.equal(asks.status, "needs");
  assert.equal(asks.ask?.command, "rm -rf build");
  assert.equal(asks.ask?.allow, "Run it");
});

test("a step's kind from its words", () => {
  assert.equal(stepKind("Edited login.js"), "edit");
  assert.equal(stepKind("Ran npm test"), "run");
  assert.equal(stepKind("Read README.md"), "read");
  assert.equal(stepKind("Searched for nextDay"), "search");
  assert.equal(stepKind("Ran git commit -m x"), "git");
  assert.equal(stepKind("Thinking"), "other");
});

test("a session's subagents as crews: each agent leads what it sent off, the session's lead first", () => {
  const subs = [
    { key: "1", lane: "codex", description: "Find callers", status: "done" as const, summary: "[harness: screened] Three callers", start: NOW - 60_000, end: NOW - 30_000, seq: 3 },
    { key: "2", lane: "main", description: "Write tests", agentType: "general-purpose", status: "running" as const, doing: "Reading x.ts", start: NOW - 10_000, seq: 4 },
  ];
  const { lanes, crewOf } = sessionCrews(subs, (l) => ({ name: l === "main" ? "Claude Code" : "Codex", tool: l === "main" ? "claude" : "codex" }), { now: NOW, marks, names, lead: "codex" });
  assert.deepEqual(lanes, ["codex", "main"]);
  assert.equal(crewOf("codex").lead.children![0]!.doing, "Three callers");
  const main = crewOf("main").lead;
  assert.equal(main.status, "working");
  assert.equal(main.children![0]!.model, undefined, "a general-purpose one says no kind");
  assert.equal(main.children![0]!.doing, "Reading x.ts");
});

test("a crew workflow's runs as a relay: what went along, what was lost, where it stands", () => {
  const runs: RoomRun[] = [
    { id: "w", name: "Launch post", run: "r2", sid: "s", seq0: 2, status: "running", at: NOW - 1000, trigger: "Run now", steps: [
      { step: "a", n: 1, kind: "do", name: "Rio", lane: "r", status: "done", title: "research", said: "Five changes" },
      { step: "b", n: 2, kind: "do", name: "Kit", lane: "k", status: "claimed", title: "write it" },
      { step: "c", n: 3, kind: "check", name: "Ada", lane: "a", status: "pending", title: "sources" },
      { step: "d", n: 4, kind: "approve", name: "You", lane: "", status: "pending", title: "OK it?" },
    ] },
    { id: "w", name: "Launch post", run: "r1", sid: "s", seq0: 1, status: "done", at: NOW - 86_400_000, trigger: "every Monday at 09:00", steps: [
      { step: "a", n: 1, kind: "do", name: "Rio", lane: "r", status: "done", title: "research", said: "Three changes" },
      { step: "b", n: 2, kind: "do", name: "Kit", lane: "k", status: "done", title: "write it", said: "A post" },
      { step: "c", n: 3, kind: "check", name: "Ada", lane: "a", status: "done", title: "sources", verdict: { pass: false, why: "No source for the number" } },
    ] },
  ];
  const { agents, relays } = workflowRelay(runs, { faceOf: (n) => n });
  assert.deepEqual(agents.map((a) => [a.name, a.status]), [["Rio", "idle"], ["Kit", "working"], ["Ada", "idle"]], "your OK isn't an agent");
  assert.deepEqual(agents[2]!.next, { title: "Launch post", more: 0 });
  assert.deepEqual(relays.map((r) => [r.from, r.to, r.items.length]), [["Rio", "Kit", 2], ["Kit", "Ada", 1]]);
  assert.equal(relays[0]!.items[0]!.state.text, "With Kit");
  assert.equal(relays[0]!.items[0]!.summary, "Five changes");
  const back = relays[1]!.items[0]!;
  assert.equal(back.state.kind, "back");
  assert.deepEqual(back.lost, [{ label: "Didn't pass the check", why: "No source for the number" }]);
});
