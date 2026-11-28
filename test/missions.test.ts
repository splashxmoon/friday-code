// Missions' rules (missions.ts), apart from the Captain running them (managers.test.ts walks a whole mission).
import assert from "node:assert/strict";
import test from "node:test";
import type { Goal, Manager } from "../src/managers.js";
import { cleanMission, doneLine, missionReport, missionStarts, nextStage, overBudget, planLines, reportDue, staged, type Mission } from "../src/missions.js";

const ms = (over: Partial<Mission> = {}): Mission => ({ done: "it works", parallel: 2, prs: false, budgetUsd: 0, rounds: 0, spent: 0, reports: [], ...over });
const goal = (over: Partial<Goal> = {}): Goal => ({ id: "g", title: "T", ask: "A", at: 1, status: "working", threads: [], mission: ms(), ...over });
const mgr = (goals: Goal[], queue: Manager["queue"]): Manager => ({ on: true, level: "run", goals, queue }) as unknown as Manager;
const q = (id: string, stage = 0, g = "g") => ({ id, text: id, at: 1, goal: g, ...(stage ? { stage } : {}) });

test("made safe: an ask and what done means are needed; threads at once kept 1 to 4; a budget rounded to cents", () => {
  assert.deepEqual(cleanMission({ ask: " " }), { ok: false, error: "Say what the mission is." });
  const c = cleanMission({ ask: "Move billing\nto the ledger", done: "  billing   reads the ledger ", parallel: 9, budgetUsd: 12.345, prs: true });
  assert.ok(c.ok);
  assert.deepEqual([c.title, c.mission.done, c.mission.parallel, c.mission.budgetUsd, c.mission.prs], ["Move billing", "billing reads the ledger", 4, 12.35, true]);
  const d = cleanMission({ ask: "x", done: "y", parallel: "nope", budgetUsd: -3 });
  assert.ok(d.ok);
  assert.deepEqual([d.mission.parallel, d.mission.budgetUsd, d.mission.prs], [2, 0, false]);
});

test("plan lines in order, stages from After lines, and the Done line read whatever its dash", () => {
  const lines = planLines("Reply: ok\n- Queue: a\n**Queue:** b\nAfter: c\nQueue: d\nFor you: hmm");
  assert.deepEqual(lines, [{ text: "a", after: false }, { text: "b", after: false }, { text: "c", after: true }, { text: "d", after: false }]);
  assert.deepEqual(staged(lines, 3).map((x) => x.stage), [3, 3, 4, 4]);
  // An After first is just the first stage.
  assert.deepEqual(staged([{ text: "x", after: true }], 0)[0]!.stage, 0);
  assert.deepEqual(doneLine("text\nDone: yes — all green"), { met: true, why: "all green" });
  assert.deepEqual(doneLine("Done: No: reports left"), { met: false, why: "reports left" });
  assert.equal(doneLine("Nothing about it"), null);
});

test("what may start: up to its threads at once, the lowest stage only, and not while an earlier stage runs or is stuck, or paused", () => {
  const g = goal({ threads: [{ sid: "s1", task: "t", state: "running" }] });
  assert.deepEqual(missionStarts(mgr([g], [q("a"), q("b"), q("c", 1)]), false).map((t) => t.id), ["a"], "one free of two");
  assert.deepEqual(missionStarts(mgr([goal()], [q("c", 1), q("a"), q("b")]), false).map((t) => t.id), ["a", "b"], "lowest stage first");
  const earlier = goal({ threads: [{ sid: "s1", task: "t", state: "stuck" }] });
  assert.deepEqual(missionStarts(mgr([earlier], [q("c", 1)]), false), [], "stage 0 stuck: stage 1 waits");
  const done = goal({ threads: [{ sid: "s1", task: "t", state: "ready" }] });
  assert.deepEqual(missionStarts(mgr([done], [q("c", 1)]), false).map((t) => t.id), ["c"]);
  assert.deepEqual(missionStarts(mgr([goal({ mission: ms({ paused: { why: "x", at: 1, by: "you" } }) })], [q("a")]), false), []);
  assert.deepEqual(missionStarts(mgr([goal()], [q("a")]), true), [], "quiet hours");
  assert.equal(nextStage(mgr([done], [q("c", 1)]), done, true), 2);
  assert.equal(nextStage(mgr([goal()], []), goal(), false), 0);
});

test("its budget, its daily report, and when a report is due", () => {
  assert.equal(overBudget(ms({ budgetUsd: 5, spent: 4.99 }), 1), null);
  assert.deepEqual(overBudget(ms({ budgetUsd: 5, spent: 5.2 }), 7), { why: "it reached its $5 budget ($5.20 spent)", at: 7, by: "budget" });
  assert.equal(overBudget(ms({ budgetUsd: 0, spent: 99 }), 1), null, "no budget, no pause");
  const g = goal({ threads: [{ sid: "a", task: "t", state: "ready" }, { sid: "b", task: "t", state: "running" }], mission: ms({ budgetUsd: 20, spent: 4.1 }) });
  assert.equal(missionReport(mgr([g], [q("c")]), g, "2026-11-27", 9).text, "Working. 1 of 3 ready · 1 running · 1 queued · $4.10 of $20.");
  assert.equal(reportDue(g, "2026-11-27", 7), false, "before 8");
  assert.equal(reportDue(g, "2026-11-27", 8), true);
  assert.equal(reportDue(goal({ mission: ms({ reports: [{ day: "2026-11-27", at: 1, text: "x" }] }) }), "2026-11-27", 9), false);
  assert.equal(reportDue(goal({ status: "done" }), "2026-11-27", 9), false, "a finished mission writes no more");
});
