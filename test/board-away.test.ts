// The Agent Board's "While you were away" card and the window bar's "3 running · 2 need you" (Arun, 2026-11-27, the board mock's
// smaller pieces): when a stretch of not looking at the app counts as away, and what the card says of it from the board's cards.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardCard } from "../src/board.js";
import type { Need } from "../src/needs-rank.js";
import { awayFacts, awaySpan, waitWords } from "../src/client/BoardAway.js";
import { AWAY_MS, seenStep } from "../src/client/seen.js";

const MIN = 60_000;
const T = 1_800_000_000_000;
const card = (o: Partial<BoardCard>): BoardCard => ({ id: `${o.sid}|main`, sid: "s", lane: "main", title: "A piece of work", task: "", agent: "Claude Code", tool: "claude", column: "idle", status: "Idle", detail: "", branch: "", files: 0, pr: null, at: T, you: false, mine: true, ...o });
const need = (o: Partial<Need>): Need => ({ id: "n", kind: "question", who: "Claude Code", where: { sid: "s", title: "A piece of work" }, text: "Which one?", choices: [], free: true, since: T, blocks: { agents: 1, tasks: 0 }, ...o }) as Need;

test("a look after half an hour or more records the stretch away; a shorter gap does not, and a kept stretch stays until a longer one", () => {
  assert.deepEqual(seenStep(null, T), { at: T });
  assert.deepEqual(seenStep({ at: T }, T + AWAY_MS - 1), { at: T + AWAY_MS - 1 });
  assert.deepEqual(seenStep({ at: T }, T + AWAY_MS), { at: T + AWAY_MS, away: { from: T, to: T + AWAY_MS } });
  const kept = { at: T + 40 * MIN, away: { from: T, to: T + 40 * MIN } };
  assert.deepEqual(seenStep(kept, T + 41 * MIN), { at: T + 41 * MIN, away: kept.away });
  assert.deepEqual(seenStep(kept, T + 200 * MIN).away, { from: T + 40 * MIN, to: T + 200 * MIN });
  // A clock set back, or a record that isn't one: starts again, no stretch.
  assert.deepEqual(seenStep({ at: T + 5 * MIN }, T), { at: T });
});

test("the card counts what moved in the stretch: finished, failed, and everything that waits, and is nothing when nothing did", () => {
  const from = T;
  const to = T + 134 * MIN;
  const cards = [
    card({ sid: "a", title: "Pricing cache", column: "ready", status: "Ready to merge", at: T + 20 * MIN }),
    card({ sid: "b", title: "Dark mode", column: "review", status: "Review pending", at: T + 60 * MIN }),
    card({ sid: "c", title: "Test runner upgrade", column: "needs", status: "CI failed", detail: "Checks are failing on the pull request", at: T + 90 * MIN }),
    // Before the stretch, and after it: neither is part of it.
    card({ sid: "d", title: "Old work", column: "ready", status: "Changes ready", at: T - 5 * MIN }),
    card({ sid: "e", title: "Since you came back", column: "ready", status: "Changes ready", at: to + MIN }),
    card({ sid: "f", title: "Still going", column: "working", status: "Working", at: T + 100 * MIN }),
  ];
  const needs = [need({ id: "n1", since: T + 122 * MIN }), need({ id: "n2", since: T - 30 * MIN }), need({ id: "n3", since: T + 10 * MIN, putOff: true })];
  const f = awayFacts(cards, needs, from, to);
  assert.deepEqual(f.finished.map((c) => c.sid), ["a", "b"]);
  assert.deepEqual(f.failed.map((c) => c.sid), ["c"]);
  assert.deepEqual(f.waiting.map((n) => n.id), ["n1", "n2"]);
  assert.equal(f.oldest, T - 30 * MIN);
  assert.equal(f.any, true);
  // Only something that waited before you left: nothing happened, no card.
  assert.equal(awayFacts([cards[3]!, cards[5]!], [needs[1]!], from, to).any, false);
  assert.equal(awayFacts([], [], from, to).any, false);
  // A question asked while you were gone is enough.
  assert.equal(awayFacts([], [needs[0]!], from, to).any, true);
});

test("how long, short and in words; and the chip's words, each part only when there is one", () => {
  assert.equal(awaySpan(134 * MIN), "2h 14m");
  assert.equal(awaySpan(45 * MIN), "45m");
  assert.equal(awaySpan(120 * MIN), "2h");
  assert.equal(awaySpan(52 * 60 * MIN), "2d 4h");
  assert.equal(waitWords(12 * MIN), "12 minutes");
  assert.equal(waitWords(MIN), "1 minute");
  assert.equal(waitWords(20_000), "under a minute");
  assert.equal(waitWords(3 * 60 * MIN), "3 hours");
  assert.equal(waitWords(72 * 60 * MIN), "3 days");
});
