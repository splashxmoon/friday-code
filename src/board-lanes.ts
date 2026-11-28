import { runOf, type SessionState } from "./session/projection.js";
import { stoppedDetail } from "./activity-line.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * The Agent Board's Timeline: what each agent of a session was doing, and when (client/BoardTimeline.tsx).
 *
 * One lane per agent, the same lanes the board's cards are (board.ts boardCards, `${sid}|${lane}`), each a row of blocks read
 * from the session's own log: its runs, where it waited on a person, where a run failed, the pull requests it opened. And the
 * hand-offs between agents, each a line from one lane to another at a moment. Nothing here is stored, and nothing is said that
 * the log doesn't: what is open now (a run, a question) is taken from the session's state, so the timeline and a card agree.
 */

/** `run`: a turn of work. `wait`: waiting on a person. `fail`: a run that stopped on an error. `done`: work handed over (a pull request). */
export type LaneBlockKind = "run" | "wait" | "fail" | "done";

export interface LaneBlock {
  /** `${sid}|${lane}|${seq}`: stable between polls, so a selected block stays selected. */
  id: string;
  kind: LaneBlockKind;
  start: number;
  /** When it ended; null while it is still going (a run under way, a question nobody has answered). */
  end: number | null;
  /** What it was asked, or what it waits for, short. */
  label: string;
  /** More to say about it: the run's last words, why it stopped, the whole question. */
  detail?: string;
  /** The event it began at. */
  seq: number;
  /** A run: the files it changed and the tools it called, where the log has them. */
  files?: number;
  tools?: number;
  /** A wait: whether it is a question or a go-ahead. */
  ask?: "question" | "approval" | "person";
  /** A pull request's link. */
  url?: string;
}

export interface BoardLane {
  /** The card's id (BoardCard.id). */
  id: string;
  sid: string;
  lane: string;
  blocks: LaneBlock[];
}

/** Work passed from one agent to another: a lead giving a task, a crew mate taking a lane's work on. `from` and `to` are lane ids as above, and may be in two sessions. */
export interface LaneHandoff {
  from: string;
  to: string;
  at: number;
  /** `task`: a lead (or the task board, or a parallel run) set it going. `handoff`: the work itself moved. */
  kind: "task" | "handoff";
}

export interface SessionLanes {
  lanes: BoardLane[];
  handoffs: LaneHandoff[];
}

/** The most blocks a lane carries: a day of short runs still fits, and a session of thousands doesn't ride every poll. */
const MAX_BLOCKS = 120;
const MAX_HANDOFFS = 60;

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

type Open = LaneBlock & { fileSet?: Set<string> };

/**
 * A session's lanes over all of its log. Read once per position of the log (app.ts caches it by lastSeq), then cut to the
 * window asked for with `lanesSince`, which slides with the clock while the log stands still.
 */
export function boardLanes(state: SessionState, events: readonly SessionEvent[]): SessionLanes {
  const sid = state.id;
  const laneIds = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  const known = new Set(laneIds);
  const blocks = new Map<string, Open[]>(laneIds.map((l) => [l, []]));
  const run = new Map<string, Open>();
  const wait = new Map<string, Open>();
  // A run's end by its event, for an end that a later one corrects (run.ended `replaces`).
  const endedAt = new Map<number, Open>();
  // What each lane was last asked, as its card's task has it: Friday's own nudges and a yes to a command are not a task.
  const lastAsk = new Map<string, string>();
  const asks = new Map<number, string>();
  const prs = new Map<string, string>();
  const handoffs: LaneHandoff[] = [];
  const idOf = (lane: string) => `${sid}|${lane}`;

  const push = (lane: string, b: Open) => (blocks.get(lane)?.push(b), b);
  const closeRun = (lane: string, ts: number) => {
    const r = run.get(lane);
    if (!r) return undefined;
    r.end = Math.max(ts, r.start);
    if (r.fileSet?.size) r.files = r.fileSet.size;
    run.delete(lane);
    return r;
  };
  const closeWait = (lane: string, ts: number, only?: LaneBlock["ask"]) => {
    const w = wait.get(lane);
    if (!w || (only && w.ask !== only)) return;
    w.end = Math.max(ts, w.start);
    wait.delete(lane);
  };
  const openWait = (lane: string, e: SessionEvent, ask: NonNullable<LaneBlock["ask"]>, label: string, detail?: string) => {
    closeWait(lane, e.ts);
    wait.set(lane, push(lane, { id: `${idOf(lane)}|${e.seq}`, kind: "wait", start: e.ts, end: null, label: clip(label, 90), ...(detail ? { detail: clip(detail, 240) } : {}), seq: e.seq, ask }));
  };
  const hand = (from: string, to: string, at: number, kind: LaneHandoff["kind"]) => {
    if (from && to && from !== to) handoffs.push({ from, to, at, kind });
  };

  for (const e of events) {
    const lane = e.lane ?? MAIN_LANE;
    const b = e.body;
    if (b.type === "hub.task.started") {
      // Friday starts a parallel run's tasks for whoever planned it: drawn from the session's lead, or its main agent.
      hand(idOf(state.lead && known.has(state.lead) ? state.lead : MAIN_LANE), idOf(b.lane), e.ts, "task");
      continue;
    }
    if (!known.has(lane)) continue;
    switch (b.type) {
      case "instruction": {
        const real = !b.approval && !b.keepGoing && !b.check && !b.text.startsWith("[session]");
        if (real) {
          const label = clip(b.mesh?.title || b.text, 90);
          if (label) (lastAsk.set(lane, label), asks.set(e.seq, label));
        }
        // Work that came from another agent: its lead's task, a lane out of usage handed on, a hand-off with what was found.
        if (b.handoff) hand(idOf(b.handoff.fromLane), idOf(lane), e.ts, "handoff");
        else if (b.mesh?.carriedFrom) hand(idOf(b.mesh.carriedFrom), idOf(lane), e.ts, "handoff");
        else if (b.mesh?.kind === "task") hand(idOf(b.mesh.fromLane), idOf(lane), e.ts, "task");
        // A go-ahead is answered by a message, as the session's state has it; a question when its answer is delivered.
        if (wait.get(lane)?.ask === "approval") closeWait(lane, e.ts);
        break;
      }
      case "instructions.delivered":
        closeWait(lane, e.ts, "question");
        break;
      case "run.started":
      case "run.resume": {
        closeRun(lane, e.ts);
        closeWait(lane, e.ts, "person");
        const label = (b.type === "run.started" ? asks.get(b.causedBy) : undefined) ?? lastAsk.get(lane) ?? "Working";
        run.set(lane, push(lane, { id: `${idOf(lane)}|${e.seq}`, kind: "run", start: e.ts, end: null, label, seq: e.seq, fileSet: new Set() }));
        break;
      }
      case "run.ended": {
        const fail = b.outcome === "error" && !b.cut;
        const set = (r: Open) => {
          r.kind = fail ? "fail" : "run";
          if (fail) r.detail = clip(stoppedDetail(b.error, e.ts) || "The run stopped.", 240);
        };
        // An end that corrects an earlier one (written as cut off, learned later to have failed): that run, not a new one.
        const earlier = b.replaces ? endedAt.get(b.replaces) : undefined;
        if (earlier) {
          set(earlier);
          break;
        }
        const r = closeRun(lane, e.ts);
        if (r) (set(r), endedAt.set(e.seq, r));
        // Ended waiting with no question on the page: it waits on a person all the same, as its card says.
        if (b.outcome === "waiting" && !wait.has(lane)) openWait(lane, e, "person", "Waiting on a person");
        break;
      }
      case "run.pause":
      case "run.cancel": {
        const r = closeRun(lane, e.ts);
        if (r && !r.detail) r.detail = "Stopped";
        closeWait(lane, e.ts);
        break;
      }
      case "agent.message": {
        const r = run.get(lane);
        if (!r) break;
        if (b.toolCalls.length) r.tools = (r.tools ?? 0) + b.toolCalls.length;
        const said = b.text.trim().split("\n").find((l) => l.trim());
        if (said) r.detail = clip(said, 240);
        break;
      }
      case "folder.edited":
        run.get(lane)?.fileSet?.add(b.path);
        break;
      case "agent.diff":
        for (const f of b.files) run.get(lane)?.fileSet?.add(f.path);
        break;
      case "agent.question":
        openWait(lane, e, "question", `Asked: ${b.question}`, b.detail ? `${b.question} ${b.detail}` : b.question);
        break;
      case "engine.approval":
        openWait(lane, e, "approval", b.scope === "turn" ? "Wants to make changes" : b.items[0] ? `Wants to run ${b.items[0]}` : "Wants to run a command", b.why ?? b.items.join(" · "));
        break;
      case "engine.detached":
        if (wait.get(lane)?.ask === "approval") closeWait(lane, e.ts);
        break;
      case "folder.committed": {
        if (b.error || !b.prUrl) break;
        const had = prs.get(lane) === b.prUrl;
        prs.set(lane, b.prUrl);
        // Once, where it was opened: later commits to the same pull request are that run's work, not another hand-over.
        if (had && !b.prCreated) break;
        const n = /\/pull\/(\d+)/.exec(b.prUrl)?.[1];
        push(lane, { id: `${idOf(lane)}|${e.seq}`, kind: "done", start: e.ts, end: e.ts, label: n ? `#${n}` : "Pull request", detail: clip(b.message, 240), seq: e.seq, url: b.prUrl });
        break;
      }
      case "pr.shepherd.ended": {
        if (b.outcome !== "merged") break;
        const url = prs.get(lane) ?? state.pr?.url;
        const n = url ? /\/pull\/(\d+)/.exec(url)?.[1] : undefined;
        push(lane, { id: `${idOf(lane)}|${e.seq}`, kind: "done", start: e.ts, end: e.ts, label: n ? `Merged #${n}` : "Merged", detail: clip(b.text, 240), seq: e.seq, ...(url ? { url } : {}) });
        break;
      }
      // The rest of a lane's work taken on by a crew mate, in a thread of its own or a room.
      case "crew.handed":
        if (b.jobLane) hand(idOf(b.lane), `${b.jobSid ?? sid}|${b.jobLane}`, e.ts, "handoff");
        break;
      case "crew.handed.room":
        if (b.roomLane) hand(idOf(b.lane), `${b.roomSid}|${b.roomLane}`, e.ts, "handoff");
        break;
      default:
        break;
    }
  }

  // What is open now is the session's to say, not this reading's: a card that says Working has a block growing into now, and
  // one that has stopped has none, whatever the log left unsaid (a runner cut off mid-run, an answer the page took another way).
  const lastTs = events.length ? events[events.length - 1]!.ts : 0;
  const after = (lane: string, seq: number, fallback: number) => events.find((x) => x.seq > seq && (x.lane ?? MAIN_LANE) === lane)?.ts ?? fallback;
  for (const lane of laneIds) {
    const list = blocks.get(lane)!;
    const now = runOf(state, lane);
    const r = run.get(lane);
    if (now.status === "running" && !r) {
      const start = now.sinceAt ?? events.find((x) => x.seq >= now.sinceSeq)?.ts ?? lastTs;
      if (start) list.push({ id: `${idOf(lane)}|${now.sinceSeq}`, kind: "run", start, end: null, label: lastAsk.get(lane) ?? "Working", seq: now.sinceSeq });
    } else if (now.status !== "running" && r) {
      r.end = Math.max(after(lane, r.seq, lastTs), r.start);
      if (now.status === "error") (r.kind = "fail"), (r.detail = clip(stoppedDetail(now.error) || "The run stopped.", 240));
    }
    const q = state.openQuestions[lane];
    const ap = state.approvals[lane];
    for (const w of list) {
      if (w.kind !== "wait") continue;
      const open = w.ask === "question" ? q?.seq === w.seq : w.ask === "approval" ? ap?.seq === w.seq : now.status === "waiting_for_human" && wait.get(lane) === w;
      if (open) w.end = null;
      else if (w.end === null) w.end = Math.max(after(lane, w.seq, w.start), w.start);
    }
  }

  return {
    lanes: laneIds.map((lane) => ({
      id: idOf(lane),
      sid,
      lane,
      blocks: blocks
        .get(lane)!
        .slice(-MAX_BLOCKS)
        .map(({ fileSet, ...b }) => ({ ...b, ...(fileSet?.size && b.files === undefined ? { files: fileSet.size } : {}) })),
    })),
    handoffs: handoffs.slice(-MAX_HANDOFFS),
  };
}

/** The part of a session's lanes that shows in a window starting at `since`: what ended in it or is still going, and the hand-offs in it. A block that began before it keeps its true start, for the page to cut at its edge. */
export function lanesSince(made: SessionLanes, since: number): SessionLanes {
  return {
    lanes: made.lanes.map((l) => ({ ...l, blocks: l.blocks.filter((b) => b.end === null || b.end >= since) })),
    handoffs: made.handoffs.filter((h) => h.at >= since),
  };
}
