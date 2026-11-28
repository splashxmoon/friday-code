// The board's week as numbers that move (Arun, 2026-11-27, the Agent Board mock's "The week, as numbers that move"): each day of
// the last seven, the seven before, and how long agents waited on this person before an answer, all read from the log.
import assert from "node:assert/strict";
import test from "node:test";
import { median, weekFacts, weekStats } from "../src/board.js";
import type { ActorRef, EventBody, SessionEvent } from "../src/types.js";

const ME = "u-me";
const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const me: ActorRef = { id: ME, name: "Me", kind: "human" };
const bo: ActorRef = { id: "u-bo", name: "Bo", kind: "human" };
const agent: ActorRef = { id: "a", name: "Agent", kind: "agent" };
let seq = 0;
const ev = (body: EventBody, ago: number, actor: ActorRef = agent, lane?: string): SessionEvent => ({ seq: ++seq, ts: NOW - ago, actor, body, ...(lane ? { lane } : {}) });
const say = (text: string, ago: number, actor = me, lane?: string) => ev({ type: "instruction", text, interrupt: false }, ago, actor, lane);
const ask = (ago: number, to = ME, lane?: string) => ev({ type: "agent.question", callId: "c", question: "Which?", to, toName: "X" }, ago, agent, lane);
const ship = (ago: number) => ev({ type: "folder.committed", sha: "a", branch: "b", message: "m", files: 1, pushed: true }, ago);
const ran = (ago: number) => ev({ type: "run.ended", outcome: "done" }, ago);

test("the median is the middle, or the mean of the middle two", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 3, 5, 100]), 4);
});

test("a question to you counts from when it was asked to your answer, and nobody else's answer counts", () => {
  const f = weekFacts([ask(DAY + 7 * MIN), say("Postgres", DAY), ask(60 * MIN, "u-bo"), say("B", 50 * MIN, bo), ask(40 * MIN), say("I'll take it", 30 * MIN, bo), say("Later", 20 * MIN)], ME, NOW);
  // The first, yours, 7 minutes. The second was Bo's. The third was yours and Bo answered it: your message after is not an answer.
  assert.deepEqual(f.waits, [{ at: NOW - DAY, ms: 7 * MIN }]);
});

test("a command to allow counts to your yes or no to that command; a stop, or Friday's own nudge, answers nothing", () => {
  const approval = (id: string, ago: number) => ev({ type: "engine.approval", id, scope: "commands", items: ["npm test"] }, ago);
  const yes = (id: string, ago: number, actor = me) => ev({ type: "instruction", text: "", interrupt: false, approval: { id, approve: true } }, ago, actor);
  const f = weekFacts(
    [
      approval("a1", 30 * MIN), yes("a1", 27 * MIN),
      // Answered by Friday (Away, commands allowed in advance): not you.
      approval("a2", 20 * MIN), yes("a2", 19 * MIN, { id: "friday", name: "Friday", kind: "system" }),
      // Asked, then the run was cancelled: what you write next answers nothing.
      ask(15 * MIN), ev({ type: "run.cancel" }, 14 * MIN, me), say("Start over", 13 * MIN),
      // Friday's carry-on is not your answer; yours after it is.
      ask(10 * MIN), ev({ type: "instruction", text: "Keep going", interrupt: false, keepGoing: true }, 9 * MIN, me), say("The first", 6 * MIN),
    ],
    ME,
    NOW,
  );
  assert.deepEqual(f.waits.map((w) => w.ms), [3 * MIN, 4 * MIN]);
});

test("a coding tool's numbered questions count to your reply, and only where a coding tool is", () => {
  const asks = "Two things before I start:\n\n1. Which database?\n   a) Postgres\n   b) SQLite\n\n2. Keep the old route?\n   a) Yes\n   b) No";
  const msg = (text: string, ago: number, lane?: string) => ev({ type: "agent.message", text, toolCalls: [] } as unknown as EventBody, ago, agent, lane);
  const attached = ev({ type: "engine.attached", engine: { tool: "claude", hostId: ME, hostName: "Me" } } as unknown as EventBody, 20 * DAY, agent, "l1");
  const f = weekFacts([attached, msg(asks, 12 * MIN, "l1"), say("1=a 2=b", 2 * MIN, me, "l1"), msg(asks, 12 * MIN), say("1=a", 2 * MIN)], ME, NOW);
  assert.deepEqual(f.waits.map((w) => w.ms), [10 * MIN], "the main lane has no coding tool: Friday's own agent asks with a question");
  // Its next words without questions take the asking back.
  const moved = weekFacts([attached, msg(asks, 12 * MIN, "l1"), msg("Never mind, found it.", 11 * MIN, "l1"), say("ok", 2 * MIN, me, "l1")], ME, NOW);
  assert.deepEqual(moved.waits, []);
});

test("the week is cut into days at the moment it is asked for, and the seven days before stand apart", () => {
  const one = weekFacts([ev({ type: "session.created", title: "A", ownerId: ME, ownerName: "Me" }, 3 * DAY, me), ship(2 * DAY + 5), ship(2 * DAY + 9), ran(2 * DAY + 3), ran(10), ran(20), ask(11 * MIN), say("a", MIN)], ME, NOW);
  const two = weekFacts([ev({ type: "session.created", title: "B", ownerId: ME, ownerName: "Me" }, 20 * DAY, me), ship(9 * DAY), ship(10), ran(8 * DAY), ran(13 * DAY), ran(15 * DAY), ask(8 * DAY + 30 * MIN), say("b", 8 * DAY), ask(5 * DAY + 4 * MIN), say("c", 5 * DAY), ask(8 * MIN), say("d", 2 * MIN)], ME, NOW);
  const w = weekStats([one, two], NOW);
  assert.deepEqual([w.sessions, w.shipped, w.runs], [1, 2, 3], "one began this week; both shipped in it; three runs");
  // Oldest first: the last is the 24 hours up to now. A session shipping twice in a day is one of that day's.
  assert.deepEqual(w.days.shipped, [0, 0, 0, 0, 1, 0, 1]);
  assert.deepEqual(w.days.runs, [0, 0, 0, 0, 1, 0, 2]);
  assert.deepEqual(w.days.waited, [null, 4 * MIN, null, null, null, null, 8 * MIN], "each day's median: 10 and 6 minutes today");
  assert.deepEqual(w.before, { shipped: 1, runs: 2, waited: 30 * MIN }, "the run fifteen days back is in neither week");
  assert.deepEqual([w.waited, w.answers], [6 * MIN, 3]);
  // The same facts a week on: this week's are last week's, with no log read again.
  const later = weekStats([one, two], NOW + 7 * DAY);
  assert.deepEqual([later.sessions, later.shipped, later.runs, later.waited], [0, 0, 0, null]);
  assert.deepEqual(later.before, { shipped: 2, runs: 3, waited: 6 * MIN });
});

test("nothing at all is zeros and nulls, never NaN", () => {
  const w = weekStats([weekFacts([], ME, NOW)], NOW);
  assert.deepEqual(w, { sessions: 0, shipped: 0, runs: 0, days: { shipped: Array(7).fill(0), runs: Array(7).fill(0), waited: Array(7).fill(null) }, before: { shipped: 0, runs: 0, waited: null }, waited: null, answers: 0 });
});
