import { randomBytes } from "node:crypto";
import { checkStateOf, fixFirstText } from "./check-state.js";
import { ASK_AGAIN_MS, cleanMission, doneLine, MISSION_PR_TEXT, MISSION_ROUNDS, missionCheckText, missionLive, missionPlanText, missionReport, missionStarts, nextStage, overBudget, planLines, reportDue, REPORTS_KEEP, staged } from "./missions.js";
import { agentModel, withSpend, DIGEST_HOUR, LOOK_MS, UNSHIPPED_MS, WAITING_MS, dayOf, inQuiet, openAsks, type Notice, keepGoals, goalsAfter, goalLine, sayText, withChat, type Goal, awayLineFor, awayReport, BATCH_MAX, BATCH_MS, IDLE_MS, tidiesIdle, RETRY_MS, RETRY_WINDOW_MS, STUCK_MS, answerText, bigTask, splitsWork, checksWork, clearReady, withMisses, withReady, type ReadyItem, asksWake, batchText, crossoverOf, enqueue, offerOf, readReply, unfinishedOf, wakesLeft, withNotes, countWake, forYouLines, settleForYou, logged, managerBrief, mayWake, nextQueued, saidLine, stepsUp, wakeFor, wakeText, type Manager, type ManagerThread, type ManagerStore, type Wake, pickThreadTool, pickCrewTool, type RankedTool, autonomyOf, doneOf, editTasks, makePlan, newAgent, parsePlan, planSayText, planState, readyTasks, rosterAgent, saveAgent, taskBrief, TASK_TRIES, withBlocked, withPlan, type CaptainAgent, type ChatCard, type Plan, type PlanTask, agentAskText, answerOf, captainNow, checkedOf, withReview, ROUNDS_MAX, criteriaOf, verdictOf, provenVerdict, proveText, withTwins, pickOf, pickTwin, withWin, judgeBrief, notesOf, withNotebook, criteriaChecksOf, criterionParts, type ShipHow, clip, liveStatus, planProgress, replanText, reportText, revisePlan, REVISIONS_MAX, toBring, withMerger, type AgentLive, planTurnHard, putAwayOld, retryTask, skipTask, taskTitle } from "./managers.js";
import { editsOf } from "./thread-edits.js";
import { spendOf } from "./spend.js";
import { modelWords } from "./cost-fall.js";
import { doingNow } from "./activity-line.js";
import { callDoing, doingWords } from "./step-words.js";
import { tokensTotal } from "./spend-price.js";
import { ENGINE_MODEL_INFO, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";
import { pendingFor, type SessionState } from "./session/projection.js";

/** A lane's run, as projection.ts runOf reads it: the main lane's is the session's own run, the others' are in laneRuns. Reading
 *  laneRuns alone called every running main lane idle (the UI session, 2026-11-25: a thread mid-task listed as idle). */
const runAt = (st: Pick<SessionState, "run" | "laneRuns">, lane: string) => (lane === MAIN_LANE ? (st.run ?? st.laneRuns?.[lane]) : st.laneRuns?.[lane]);
const statusAt = (st: Pick<SessionState, "run" | "laneRuns">, lane: string) => runAt(st, lane)?.status ?? "idle";

/**
 * The project Manager at work (managers.ts holds its record and rules): its own session and lane, woken by what happens in its
 * project's sessions, its replies read back into its log, and the queue started when the project goes quiet. Everything it touches
 * comes in through `Deps`, so the tests run it against a store of their own.
 */

export interface Me {
  id: string;
  name: string;
}

export interface Deps {
  managers: ManagerStore;
  state: (sid: string) => Promise<SessionState | null>;
  events: (sid: string) => Promise<SessionEvent[]>;
  exists: (sid: string) => Promise<boolean>;
  /** A new session of the person's, hidden or not. */
  create: (title: string, me: Me, manager?: string) => Promise<string>;
  /** Kept out of the person's sidebar (a Manager's own session). */
  hide: (sid: string, me: Me) => Promise<void>;
  /** An instruction from the person, as a typed message. */
  instruct: (sid: string, me: Me, text: string) => Promise<void>;
  /** An instruction from Friday on one lane, waking it. */
  tell: (sid: string, lane: string, text: string) => Promise<boolean>;
  /** `copy`: in a copy of the folder of its own (a git worktree), as a mission's threads run, several at once. */
  /** `newLane`: a new lane of that name in the session (a Captain's agent, beside it in its own session). */
  startTool: (sid: string, me: Me, p: { tool: EngineTool; cwd: string; model?: string; lane?: string; newLane?: string; project: string; copy?: boolean }) => Promise<{ lane: string }>;
  /** About what a session's agents have spent, in dollars (spend.ts prices): a mission's budget is counted from its threads. */
  spent?: (sid: string) => Promise<number>;
  stop: (sid: string, me: Me, lane: string) => Promise<void>;
  me: () => Promise<Me>;
  /** The person's sessions, newest first. */
  sessions: (me: Me) => Promise<string[]>;
  /** The tool to start a queued task with. */
  toolFor: (me: Me, task: string) => Promise<EngineTool | null>;
  /** The router's ranking of the tools ready here for a task (routing.ts rankTools): with it, pickThreadTool chooses; without, toolFor. */
  ranked?: (me: Me, task: string) => Promise<RankedTool[]>;
  folderKey: (p: string) => string;
  limitHit: (error: string) => boolean;
  /** Friday's Check it on a thread's lane: false when there's nothing to check or proof is off there. */
  check?: (sid: string, lane: string) => Promise<boolean>;
  /** A thread's finished work as a ready card, read from its log (no model). */
  readyOf?: (sid: string, lane: string) => Promise<Omit<ReadyItem, "at"> | null>;
  /**
   * A big task split into parts (spec 14, Run): a session of the person's in its own copy of the project, its hub planned and
   * approved, its parts started. `split: false` when it couldn't be planned and runs as one thread there instead; null when it
   * can't be split here at all (no git, say), so it starts as an ordinary thread.
   */
  split?: (m: Manager, task: string, me: Me, pick?: { tool: EngineTool; model?: string; why: string; set?: true }) => Promise<{ sid: string; split: boolean; parts?: number; why?: string } | null>;
  /** The person's Away, while it's on (teammates.ts away): its check-ins say so, and it decides what it can (spec 14: Away). */
  away?: () => Promise<{ until: number; since: number } | null>;
  /** Whether the person has the session open now: an idle thread in front of them is left alone. */
  viewing?: (sid: string) => Promise<boolean>;
  /**
   * A lane's copy brought into the folder it was made from (core folder.apply): files brought over and any conflict markers left.
   * Throws when it couldn't; nothing new to bring is files 0.
   */
  apply?: (sid: string, lane: string) => Promise<{ files: number; conflicts: string[] }>;
  /**
   * A lane whose coding tool isn't attached any more (Friday restarted, an update, an idle tidy) started again on it, its tool and
   * model as they were and its conversation carried on where the tool can, as the page's own quiet reconnect does (reattach.ts).
   * Already attached: fine. Why not, when it couldn't.
   */
  revive?: (sid: string, lane: string) => Promise<{ ok: true } | { ok: false; why: string }>;
  /** One command run by Friday itself in a lane's folder (a criterion's check, safeCheck'd): passed or not, and its output's end. */
  run?: (sid: string, lane: string, command: string) => Promise<{ ok: boolean; out: string } | null>;
  /** A message queued on a lane and not yet delivered taken back (core instruction.withdraw). */
  withdraw?: (sid: string, lane: string, seq: number) => Promise<boolean>;
  /** How long the Captain's lane has to start a run on the person's message before the chat says it couldn't (START_GUARD_MS). */
  startGuardMs?: number;
  /** A lane gone for good, with its copy: a split's part once its work is brought together. */
  retire?: (sid: string, lane: string, copy: string | null) => Promise<void>;
  /** Whether a coding tool is near its usage limit (NEAR_LIMIT): what would spend more on it (a stronger model, a split) holds back. */
  nearLimit?: (tool: EngineTool) => Promise<boolean>;
  /**
   * A proof clip of a finished plan's UI work, on the Captain's own lane (the project folder): false when nothing there draws. `key`
   * makes it once a plan; `asked` (the Recap's Record) makes it again, whatever the proof clips setting.
   */
  prove?: (sid: string, lane: string, key: string, o: { asked?: boolean; summary?: string }) => Promise<boolean>;
  /** A finished goal's files committed to `branch` in the Captain's lane's folder (only those), then pushed or a pull request opened. */
  ship?: (sid: string, lane: string, o: { how: Exclude<ShipHow, "folder">; branch: string; title: string; body: string; only: string[] }) => Promise<{ branch?: string; sha?: string; pushed?: true; prUrl?: string; error?: string }>;
  /** A pull request's state on GitHub (cached a minute app-side), for tidying after a merge. */
  prState?: (sid: string, url: string) => Promise<"open" | "merged" | "closed" | null>;
  /** How often it looks over its project (LOOK_MS). */
  lookMs?: number;
  /** How long a thread is quiet before its tool is stopped (IDLE_MS). */
  idleMs?: number;
  /** How long before an errored thread is asked to try again (RETRY_MS); 0 at once (the tests). */
  retryMs?: number;
  /** A question for the person, or work ready for them: to their phone when they're away from the computer (spec 14, P3). */
  notify?: (m: Manager, n: { kind: "ask"; at: number; text: string; sid?: string } | { kind: "ready"; item: ReadyItem } | { kind: "report"; text: string; sid: string }) => void;
  /** Lessons it learned, into the project's memory every agent there is told. */
  learn?: (m: Manager, lines: string[]) => Promise<void>;
  /** How long wakes are gathered into one (BATCH_MS); 0 sends each at once (the tests). */
  batchMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** What a split's main agent is asked once its parts are together: one look over the whole, in its own copy, nothing committed. */
export const splitReview = (title: string, body: { tasks: number; done: number; why?: string }) =>
  `[Friday] The parts of "${title}" are done and brought together here (${body.done} of ${body.tasks}${body.why ? `; ${body.why}` : ""}). Look over the whole change as one piece: check the parts fit together (names, imports, anything one assumed of another), run the project's checks, fix what doesn't fit, and say in two or three lines where it stands. Don't commit, push or open a pull request: the person ships it.`;

/**
 * The folder a lane works for: the folder itself for a lane in its own copy of it, and for a copy of a copy (a split task's part,
 * made from its session's own copy), the folder that copy was made from.
 */
export const laneFolder = (state: SessionState | null, lane: string): string | null => {
  const e = state?.engines[lane];
  if (!e) return null;
  const f = e.copyOf ?? e.cwd ?? null;
  const from = f && e.copyOf ? Object.values(state!.engines).find((x) => x !== e && x.cwd === f && x.copyOf) : undefined;
  return from?.copyOf ?? f;
};

const TOOL_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", copilot: "GitHub Copilot", opencode: "OpenCode", pi: "Pi" };

export function managersRun(d: Deps) {
  const now = () => (d.now ? d.now() : Date.now());
  const say = d.log ?? ((m: string) => console.error(m));
  /** When each lane last woke its Manager, by `${managerId}:${sid}:${lane}`. */
  const lastWake = new Map<string, number>();
  /** The model each Manager's lane runs on now, by id. */
  const onModel = new Map<string, string>();
  /** Lanes in a stuck run already told, by `${sid}:${lane}`, with the event seq it was told at. */
  const stuckTold = new Map<string, number>();
  const ownSessions = new Set<string>();

  const forFolder = async (folder: string): Promise<Manager | null> => {
    const key = d.folderKey(folder);
    return (await d.managers.list()).find((m) => m.project.key === key) ?? null;
  };

  /** Its session and lane being made, by Captain id: one at a time, so a message right after it's turned on finds it. */
  const ensuring = new Map<string, Promise<Manager>>();
  /** Its session and lane, made and started when it hasn't one that is still there. */
  const ensure = (m: Manager): Promise<Manager> => {
    const going = ensuring.get(m.id);
    if (going) return going;
    const p = ensureNow(m).finally(() => ensuring.delete(m.id));
    ensuring.set(m.id, p);
    return p;
  };
  const ensureNow = async (m0: Manager): Promise<Manager> => {
    // As it is now: another ensure may have made its session since this record was read.
    let m = (await d.managers.get(m0.id)) ?? m0;
    // Its conversation got long: a fresh session, carrying what it learned and how things stand (its brief), so each wake reads less.
    // Not while a plan runs: its agents are lanes in this session, and a fresh one would leave them behind.
    // Nor ever on the new flow: its session holds its agents' lanes, their history and the page's view of them (the audit,
    // 2026-11-27: a fresh session after a plan left the page with no lanes); its tool compacts its own conversation instead.
    if (m.rotate && m.sid && !m.autonomy && !m.plans?.some((p) => p.status === "running")) {
      await stopIt(m);
      const ctx = m.spend?.context;
      m =
        (await d.managers.update(m.id, (cur) => {
          const { sid: _s, lane: _l, rotate: _r, ...rest } = cur;
          return logged(rest as Manager, { at: now(), kind: "said", text: `Started a fresh session: its conversation was getting long${ctx ? ` (${Math.round(ctx / 1000)}k tokens)` : ""}; kept what it learned and where things stand` });
        })) ?? m;
    }
    const me = await d.me();
    if (m.sid && m.lane && (await d.exists(m.sid))) {
      ownSessions.add(m.sid);
      // Given work with no tool on its lane (detached by a restart or an update): started again first, or the message would sit
      // there with nothing to run it (Arun's edge Captain, 2026-11-27: "Thinking…" for good).
      // In the background: a start can take a while (or fail slowly), and the message waits in the lane's queue for it anyway.
      void revive(m.id, m.sid, m.lane).catch(() => false);
      return m;
    }
    const sid = await d.create(`Captain · ${m.project.name}`, me, m.id);
    ownSessions.add(sid);
    await d.instruct(sid, me, managerBrief(m));
    const { lane } = await d.startTool(sid, me, { tool: m.tool, cwd: m.project.folder, model: m.model, project: m.project.name });
    // Out of the person's list once its first words and its tool are in (an instruction puts a session back on the list).
    await d.hide(sid, me).catch(() => {});
    onModel.set(m.id, m.model);
    return (await d.managers.update(m.id, (cur) => ({ ...cur, sid, lane: lane || MAIN_LANE }))) ?? m;
  };

  /** Why each Captain's own lane couldn't be started again, by id, for the chat if its message then never runs. */
  const reviveWhy = new Map<string, { why: string; at: number }>();
  /** A lane's tool started again if it isn't attached; whether it's there now. */
  const revive = async (id: string, sid: string, lane: string): Promise<boolean> => {
    if (!d.revive) return true;
    const st = await d.state(sid).catch(() => null);
    const e = st?.engines[lane];
    if (!e?.tool || e.online) return true;
    const r = await d.revive(sid, lane).catch((x: Error) => ({ ok: false as const, why: x.message }));
    if (r.ok) {
      reviveWhy.delete(id);
      say(`[managers] started ${lane} in ${sid} again`);
      return true;
    }
    reviveWhy.set(id, { why: r.why, at: now() });
    say(`[managers] couldn't start ${lane} in ${sid} again: ${r.why}`);
    // Its own lane, with the person's message waiting: said now, not when the 30 s guard comes round. It can't run that message,
    // and a page polling every few seconds shouldn't wait out a timer that a busy server fires late (the audit's full spec run).
    const own = (await d.managers.get(id).catch(() => null)) ?? null;
    if (own && own.sid === sid && (own.lane ?? MAIN_LANE) === lane && replying.has(id)) await markStall(id, TOOL_LABEL[e.tool] ?? e.tool, r.why);
    return false;
  };
  /** A detached lane started again and waited for until its runner is back (up to REATTACH_MS), for work done through it. */
  const reattach = async (id: string, sid: string, lane: string): Promise<boolean> => {
    if (!d.revive) return false;
    const st = await d.state(sid).catch(() => null);
    if (st?.engines[lane]?.online) return true;
    if (!(await revive(id, sid, lane))) return false;
    // Counted in real waits, not the clock, which a test holds still.
    for (let i = 0; i < REATTACH_MS / 500; i++) {
      if ((await d.state(sid).catch(() => null))?.engines[lane]?.online) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return !!(await d.state(sid).catch(() => null))?.engines[lane]?.online;
  };
  /** Something for one of its agents' lanes, its tool started again first if it was detached. */
  const tellLane = async (sid: string, lane: string, text: string): Promise<boolean> => {
    await revive("", sid, lane);
    return d.tell(sid, lane, text);
  };

  /** Its lane stopped (turned off or removed); its session stays for its history. */
  const stopIt = async (m: Manager) => {
    if (!m.sid || !m.lane) return;
    const me = await d.me();
    await d.stop(m.sid, me, m.lane).catch(() => {});
    onModel.delete(m.id);
  };

  /** Its lane on the model this wake needs: the step-up one for a hard thing, its everyday one otherwise. */
  const modelFor = async (m: Manager, w: Wake): Promise<Manager> => {
    // Near its tool's usage limit, it stays on its everyday model: a stronger one would spend the rest faster.
    const tight = m.stepUp && stepsUp(m, w, now()) && d.nearLimit ? await d.nearLimit(m.tool).catch(() => false) : false;
    const want = m.stepUp && stepsUp(m, w, now()) && !tight ? m.stepUp : m.model;
    const had = onModel.get(m.id) ?? m.model;
    if (want === had || !m.sid || !m.lane) return m;
    const me = await d.me();
    await d.startTool(m.sid, me, { tool: m.tool, cwd: m.project.folder, model: want, lane: m.lane, project: m.project.name });
    onModel.set(m.id, want);
    const up = !!m.stepUp && want === m.stepUp;
    return (await d.managers.update(m.id, (cur) => logged({ ...cur, ...(up ? { steppedUntil: now() + 15 * 60_000 } : {}) }, { at: now(), kind: "stepped-up", text: up ? `Stepped up to ${want} for a hard one` : `Back on ${want}` }))) ?? m;
  };

  /** Wakes gathered for each Captain, sent together after BATCH_MS so several things cost one turn. */
  const pending = new Map<string, Wake[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const batchMs = d.batchMs ?? BATCH_MS;
  const nameOf = (st: SessionState | null, lane: string) => {
    const tool = st?.engines[lane]?.tool;
    return st?.lanes.find((l) => l.id === lane)?.name ?? (tool ? (TOOL_LABEL[tool] ?? tool) : lane === MAIN_LANE ? "The main agent" : lane);
  };
  const wokeWords = (w: Wake, laneName: string, title: string) =>
    `${w.kind === "question" ? `${laneName} asked a question` : w.kind === "circles" ? `${laneName} was going in circles` : w.kind === "stuck" ? `${laneName} had nothing new for a while` : w.kind === "offer" ? `${laneName} stopped to ask leave to go on` : w.kind === "unfinished" ? `${laneName} stopped with its plan unfinished` : w.kind === "crossover" ? `${laneName} changed files another thread is on` : `${laneName} stopped with an error`} in "${title.slice(0, 60)}"`;

  /** Everything gathered for one Captain, sent as one wake (at most BATCH_MAX; the rest go next). */
  const flush = async (id: string): Promise<"sent" | "skipped" | "failed"> => {
    timers.delete(id);
    const all = pending.get(id) ?? [];
    pending.delete(id);
    if (!all.length) return "skipped";
    const items = all.slice(0, BATCH_MAX);
    if (all.length > BATCH_MAX) {
      pending.set(id, all.slice(BATCH_MAX));
      timers.set(id, setTimeout(() => void flush(id), Math.max(batchMs, 1)));
    }
    const m = await d.managers.get(id);
    if (!m?.on) return "skipped";
    if (wakesLeft(m, now()) <= 0) {
      await d.managers.update(id, (cur) => logged(cur, { at: now(), kind: "skipped", text: "Out of today's budget" }));
      return "skipped";
    }
    try {
      let cur = await ensure(m);
      cur = await modelFor(cur, { hard: items.some((w) => w.hard) } as Wake);
      const parts: string[] = [];
      const woke: { text: string; sid: string; lane: string }[] = [];
      for (const w of items) {
        const st = await d.state(w.sid);
        const laneName = nameOf(st, w.lane);
        const title = st?.title ?? "a session";
        const tool = st?.engines[w.lane]?.tool;
        const other = w.other ? await d.state(w.other.sid) : null;
        parts.push(wakeText(w, { title, laneName, ...(tool ? { tool } : {}), ...(other ? { otherTitle: other.title, otherLane: nameOf(other, w.other!.lane) } : {}) }));
        woke.push({ text: wokeWords(w, laneName, title), sid: w.sid, lane: w.lane });
      }
      const away = d.away ? await d.away().catch(() => null) : null;
      const ok = await d.tell(cur.sid!, cur.lane!, batchText(parts, cur, away && away.until > now() ? away.until : undefined));
      if (!ok) return "failed";
      await d.managers.update(id, (x) => woke.reduce((acc, a) => logged(acc, { at: now(), kind: "woke", ...a }), countWake(x, now())));
      return "sent";
    } catch (e) {
      say(`[managers] ${m.project.name}: couldn't wake it: ${(e as Error).message}`);
      await d.managers.update(id, (x) => logged(x, { at: now(), kind: "skipped", text: `Couldn't start: ${(e as Error).message}`.slice(0, 200) }));
      return "failed";
    }
  };

  /** A wake for it, if its rules allow one now: gathered with others and sent together. What happened, for the tests. */
  const wake = async (m: Manager, w: Wake): Promise<"sent" | "queued" | "skipped" | "failed"> => {
    const key = `${m.id}:${w.sid}:${w.lane}`;
    // A thread you're looking at right now: its question, its offer to go on, its unfinished plan are in front of you, so the
    // Captain spends nothing on them (2026-11-25: "optimized for cost"). Stuck, circling, errors and crossovers still wake it.
    if ((w.kind === "question" || w.kind === "offer" || w.kind === "unfinished") && d.viewing && (await d.viewing(w.sid).catch(() => false))) return "skipped";
    const may = mayWake(m, lastWake.get(key), now());
    if (!may.ok) {
      // Said once per thread and reason, not on every event.
      if (may.why !== "off" && may.why !== "Just looked at this thread") {
        const seen = m.log.find((a) => a.kind === "skipped" && a.sid === w.sid && a.lane === w.lane && a.text === may.why && now() - a.at < 60 * 60_000);
        if (!seen) await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "skipped", text: may.why, sid: w.sid, lane: w.lane }));
      }
      return "skipped";
    }
    lastWake.set(key, now());
    const list = pending.get(m.id) ?? [];
    if (!list.some((x) => x.sid === w.sid && x.lane === w.lane && x.kind === w.kind)) list.push(w);
    pending.set(m.id, list);
    if (batchMs <= 0) return flush(m.id);
    if (!timers.has(m.id)) {
      const t = setTimeout(() => void flush(m.id), batchMs);
      (t as { unref?: () => void }).unref?.();
      timers.set(m.id, t);
    }
    return "queued";
  };

  /** How many lanes are running in a Manager's project, across the person's sessions. */
  const runningIn = async (m: Manager, me: Me): Promise<number> => {
    let n = 0;
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || sid === m.sid) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      for (const lane of Object.keys(st.engines)) {
        if (statusAt(st, lane) !== "running") continue;
        const f = laneFolder(st, lane);
        if (f && d.folderKey(f) === m.project.key) n++;
      }
    }
    return n;
  };

  /** A goal's task started: its thread is the goal's now, running. */
  const attachToGoal = async (m: Manager, task: { goal?: string; text: string; stage?: number }, sid: string) =>
    d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === task.goal);
      if (!g) return null;
      const thread = { sid, task: task.text.slice(0, 200), state: "running" as const, ...(task.stage ? { stage: task.stage } : {}) };
      return goalsAfter({ ...cur, goals: cur.goals!.map((x) => (x.id === g.id ? { ...x, threads: [...x.threads, thread] } : x)) }, null, null).m;
    });
  /** The tool (and model) a thread it starts runs on, and why: pickThreadTool over the router's ranking, with the project's threads. */
  const choose = async (m: Manager, text: string, me: Me): Promise<{ tool: EngineTool; model?: string; why: string; set?: true } | null> => {
    if (d.ranked) {
      const ranked = await d.ranked(me, text).catch(() => [] as RankedTool[]);
      const threads = (await threadsOf([m], me).catch(() => new Map<string, ManagerThread[]>())).get(m.id) ?? [];
      return pickThreadTool(ranked, { ...m, threads }, text);
    }
    const t = await d.toolFor(me, text).catch(() => null);
    return t ? { tool: t, why: "" } : null;
  };
  /**
   * The tool a plan's step runs on, and why (pickCrewTool): the router's ranking for its words, weighed with how many of the crew
   * already work on each tool, the tools that wrote what it waits on (a check gets a second opinion), and tools near their limit.
   */
  const chooseCrew = async (m: Manager, plan: Plan, task: PlanTask, me: Me): Promise<{ tool: EngineTool; model?: string; why: string } | null> => {
    if (!d.ranked) return choose(m, task.text, me);
    const ranked = await d.ranked(me, task.text).catch(() => [] as RankedTool[]);
    const busy: Partial<Record<EngineTool, number>> = {};
    for (const a of m.agents ?? []) if (a.status === "working" || a.status === "needs") busy[a.tool] = (busy[a.tool] ?? 0) + 1;
    const wrote = task.after.flatMap((id) => {
      const t = plan.tasks.find((x) => x.id === id);
      const a = t?.agent ? m.agents?.find((x) => x.id === t.agent) : undefined;
      return a ? [a.tool] : [];
    });
    const limited = d.nearLimit ? (await Promise.all(ranked.filter((r) => !r.out).slice(0, 4).map(async (r) => ((await Promise.resolve(d.nearLimit!(r.tool)).catch(() => false)) ? r.tool : null)))).filter((t): t is EngineTool => !!t) : [];
    // The second of two attempts: on another tool than the first's, when one is nearly as good.
    const twin = task.twin ? plan.tasks.find((x) => x.id === task.twin) : undefined;
    const rival = twin?.agent ? m.agents?.find((x) => x.id === twin.agent)?.tool : undefined;
    return pickCrewTool(ranked, m, task, { busy, wrote, limited, ...(rival ? { rival } : {}) });
  };
  /** The judge's brief: both attempts' agents, results, checks and diffs, read from their lanes (judgeBrief). */
  const judgeText = async (m: Manager, plan: Plan, task: PlanTask, agent: Pick<CaptainAgent, "name" | "role" | "brief">, ask: string): Promise<string> => {
    const attempts = await Promise.all(
      (task.judge ?? []).map(async (id) => {
        const t = plan.tasks.find((x) => x.id === id);
        const a = t?.agent ? m.agents?.find((x) => x.id === t.agent) : undefined;
        const st = t?.sid ? await d.state(t.sid).catch(() => null) : null;
        const files = (t?.lane && st?.diffs?.[t.lane]?.files) || [];
        const diff = files.map((f) => f.patch || `${f.status} ${f.path}`).join("\n");
        return { name: a?.name ?? t?.role ?? "An agent", tool: TOOL_LABEL[a?.tool ?? ""] ?? a?.tool ?? "its tool", ...(t?.result ? { result: t.result } : {}), ...(t?.checked ? { checked: t.checked } : {}), diff };
      }),
    );
    const first = plan.tasks.find((x) => x.id === task.judge?.[0]);
    return judgeBrief(m, task, agent, attempts, ask, first?.text ?? "", m.goals?.find((g) => g.id === plan.goal));
  };
  /** The next queued task started in a session of its own, when its rules allow; the session's id, or null. */
  const startQueued = async (m: Manager): Promise<string | null> => {
    const me = await d.me();
    const running = await runningIn(m, me);
    const task = nextQueued(m, running, now());
    if (!task) return null;
    // Taken off first, under its lock, so two ends at once never start it twice.
    let took = false;
    await d.managers.update(m.id, (cur) => {
      if (!cur.queue.some((q) => q.id === task.id)) return null;
      took = true;
      return { ...cur, queue: cur.queue.filter((q) => q.id !== task.id) };
    });
    if (!took) return null;
    // Big, on Run with splitting on: parts at once, each in its own copy, brought together for you.
    // Near the limit of the tool it would run on, a big task isn't split: parts at once spend it several times as fast.
    const pick = await choose(m, task.text, me);
    const busy = d.nearLimit && pick ? await Promise.resolve(d.nearLimit(pick.tool)).catch(() => false) : false;
    if (splitsWork(m) && d.split && bigTask(task.text) && !busy) {
      const r = await d.split(m, task.text, me, pick ?? undefined).catch((e: Error) => (say(`[managers] split: ${e.message}`), null));
      if (r) {
        if (task.goal) await attachToGoal(m, task, r.sid);
        const what = task.text.slice(0, 80);
        await d.managers.update(m.id, (cur) =>
          logged(cur, { at: now(), kind: "started", text: r.split ? `Split "${what}" into ${r.parts ?? "its"} parts` : `Started "${what}" as one thread (couldn't split it: ${(r.why ?? "no plan").slice(0, 120)})`, sid: r.sid }),
        );
        return r.sid;
      }
    }
    const tool = pick?.tool;
    if (!tool) {
      await d.managers.update(m.id, (cur) => logged({ ...cur, queue: [task, ...cur.queue] }, { at: now(), kind: "skipped", text: "No coding tool is ready to start the next task" }));
      return null;
    }
    const sid = await d.create(task.text.split("\n")[0]!.slice(0, 80), me);
    await d.instruct(sid, me, task.text);
    await d.startTool(sid, me, { tool, cwd: m.project.folder, project: m.project.name, ...(pick?.model ? { model: pick.model } : {}) });
    // Which tool and why, said where you read what it did (2026-11-25: "what agents it will select for use").
    await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "started", text: `Started "${task.text.slice(0, 80)}" from the queue on ${TOOL_LABEL[tool] ?? tool}${pick?.why ? `: ${pick.why}` : ""}`, sid }));
    if (task.goal) await attachToGoal(m, task, sid);
    return sid;
  };

  /** Its reply after a wake, read back: what it said, and anything it leaves to the person. */
  const heardReply = async (m: Manager, sid: string, lane: string) => {
    const evs = await d.events(sid);
    const start = evs.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
    const said = evs.filter((e) => e.seq > start && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent").map((e) => (e.body as { text?: string }).text ?? "").join("\n").trim();
    if (!said) return;
    const r = readReply(said);
    const line = saidLine(said) || r.said;
    // Turns it was asked for about its plans (Captain v2): an agent's question, a revision, the summary.
    const planTurn = await planTurns(m, evs, lane, said, r);
    let queued = false;
    // A mission's plan or judgement it was asked for (missions.ts): its Queue/After lines are the mission's, staged; its Done line ends
    // the mission or plans what's left.
    const pending = missionAsk.get(m.id);
    if (pending) missionAsk.delete(m.id);
    const plan = pending ? planLines(said) : [];
    /** A mission made from what the person asked, this reply (one way in). */
    let missionMade = false;
    /** A plan made from what the person asked, this reply (Captain v2). */
    let planMade = "";
    const verdict = pending?.kind === "judge" ? doneLine(said) : null;
    const asked: { at: number; text: string; sid?: string }[] = [];
    // A reply to the person's own message: what it says after their message goes to their conversation, and on Run, work they asked
    // for is a goal. Its turn can carry what it said before their message came (its first, say), which isn't their reply; and a turn
    // that ended before it got to their message leaves it still waiting for one.
    let toYou = replying.get(m.id);
    let reply = r;
    /** Its words to the person as written, for a plan (Captain v2). */
    let raw = said;
    if (toYou) {
      const asked = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && /^\[Captain message\]/.test((e.body as { text?: string }).text ?? ""));
      // What it said once it had the message: from the turn it started (run.started caused by it), or from when it was handed into a
      // turn under way (instructions.delivered). A turn going when it came ends with words of its own first.
      const began = asked
        ? evs.find((e) => e.seq > asked.seq && (e.lane ?? MAIN_LANE) === lane && ((e.body.type === "run.started" && e.body.causedBy === asked.seq) || (e.body.type === "instructions.delivered" && e.body.seqs.includes(asked.seq))))
        : undefined;
      const after = began ? evs.filter((e) => e.seq > began.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent").map((e) => (e.body as { text?: string }).text ?? "").join("\n").trim() : "";
      raw = after || said;
      const marked = readReply(after || said);
      if (marked.reply) {
        reply = { ...readReply(after || said), prose: marked.reply };
        replying.delete(m.id);
      } else if (after) {
        reply = readReply(after);
        replying.delete(m.id);
      } else toYou = undefined;
    }
    await d.managers.update(m.id, (cur) => {
      asked.length = 0;
      let next = cur;
      let goal: string | undefined;
      const mg = pending ? cur.goals?.find((g) => g.id === pending.goal && g.mission && g.status !== "cancelled") : undefined;
      if (mg) {
        const ms = mg.mission!;
        let status: Goal["status"] = mg.status;
        let mission = { ...ms, asked: undefined };
        if (verdict) mission = { ...mission, verdict: { ...verdict, at: now() }, rounds: ms.rounds + 1 };
        if (verdict?.met) status = "done";
        else if (plan.length) {
          const from = nextStage(cur, mg, mg.threads.length > 0 || cur.queue.some((q) => q.goal === mg.id));
          for (const t of staged(plan, from)) {
            const added = enqueue(next, t.text, now(), mg.id);
            if (typeof added === "string") break;
            next = { ...added, queue: added.queue.map((q, i) => (i === added.queue.length - 1 ? { ...q, ...(t.stage ? { stage: t.stage } : {}) } : q)) };
          }
          status = "working";
          queued = true;
        } else if (verdict || pending!.kind === "plan") status = "stuck";
        if (status === "stuck" && !r.forYou.length) r.forYou.push(`Mission "${mg.title}": ${verdict?.why || "it couldn't plan what's left"}. Say how to go on, or give it up.`);
        if (verdict && !verdict.met && mission.rounds >= MISSION_ROUNDS && status === "working") {
          // Round after round and still not done: the person decides, not another lap.
          next = { ...next, queue: next.queue.filter((q) => q.goal !== mg.id) };
          status = "stuck";
          r.forYou.push(`Mission "${mg.title}" has gone ${MISSION_ROUNDS} rounds without meeting "${ms.done}". Last: ${verdict.why || "not met"}. Keep going, change what done means, or give it up?`);
        }
        next = { ...next, goals: next.goals!.map((g) => (g.id === mg.id ? { ...g, status, mission } : g)) };
        const said = verdict ? (verdict.met ? `Mission done: ${mg.title}${verdict.why ? ` (${verdict.why})` : ""}` : `Mission not done yet: ${mg.title}${verdict.why ? ` (${verdict.why})` : ""}${plan.length ? `; ${plan.length} more task${plan.length === 1 ? "" : "s"}` : ""}`) : `Mission planned: ${mg.title} (${plan.length} task${plan.length === 1 ? "" : "s"})`;
        next = logged(next, { at: now(), kind: "said", text: said });
      }
      if (toYou && cur.autonomy && planTurn !== "revised") {
        // Captain v2: work asked for comes back as a plan, kept as a draft with its own card in the chat; a question, as words.
        const p = parsePlan(raw);
        const rr = readReply(p.rest);
        const words = rr.reply || rr.prose || (p.tasks.length ? "Here's the plan." : "Done.");
        if (p.tasks.length) {
          const gid = `g_${randomBytes(4).toString("hex")}`;
          // A review added when it builds in several steps and nothing checks them (withReview).
          // Then a step marked "(two tries)" made two attempts and a judge (withTwins).
          const plan = makePlan(`p_${randomBytes(4).toString("hex")}`, gid, withTwins(withReview(p.tasks, `${toYou.text}\n${criteriaOf(raw).join("\n")}`)), now());
          const title = p.title || toYou.text.split("\n")[0]!.slice(0, 80);
          // Its brief kept with the goal: what done means and how it's checked, judged after each round (reportText).
          const done = toYou.done || rr.doneWhen;
          const criteria = criteriaOf(raw);
          // The commands that prove them, which Friday runs itself once a round is done (provenVerdict).
          const checks = criteriaChecksOf(raw);
          next = { ...next, goals: keepGoals([{ id: gid, title, ask: toYou.text, at: now(), status: "working", threads: [], ...(done ? { done } : {}), ...(criteria.length ? { criteria } : {}), ...(Object.keys(checks).length ? { checks } : {}) }, ...(next.goals ?? [])]) };
          next = logged(withChat(withPlan(next, plan), "captain", words, now(), { kind: "plan", plan: plan.id }), { at: now(), kind: "said", text: `Plan: ${title} (${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"})` });
          planMade = plan.id;
        } else next = withChat(next, "captain", words, now());
      } else if (toYou) {
        next = withChat(next, "captain", reply.prose || saidLine(reply.prose) || "Done.", now());
        const asked = planLines(said);
        if (reply.goal && cur.level === "run" && asked.length) {
          // One way in (2026-11-27): work asked for on Run is a mission, done when their words say (or its own), with the box's
          // settings; its tasks staged by their Queue and After lines.
          goal = `g_${randomBytes(4).toString("hex")}`;
          const c = cleanMission({ ask: toYou.text, title: reply.goal, done: toYou.done || reply.doneWhen || reply.goal, parallel: toYou.parallel, budgetUsd: toYou.budgetUsd, prs: toYou.prs });
          const g: Goal = { id: goal, title: reply.goal, ask: toYou.text, at: now(), status: "working", threads: [], ...(c.ok ? { mission: c.mission } : {}) };
          next = logged({ ...next, goals: keepGoals([g, ...(next.goals ?? [])]) }, { at: now(), kind: "said", text: `Mission: ${reply.goal} (${asked.length} task${asked.length === 1 ? "" : "s"})` });
          for (const t of staged(asked, 0)) {
            const added = enqueue(next, t.text, now(), goal);
            if (typeof added === "string") break;
            next = { ...added, queue: added.queue.map((q, i) => (i === added.queue.length - 1 && t.stage ? { ...q, stage: t.stage } : q)) };
          }
          missionMade = true;
          queued = true;
        }
      }
      // The thread it was last woken about: what its questions are about.
      const about = cur.log.find((a) => a.kind === "woke")?.sid;
      if (line) next = logged(next, { at: now(), kind: "said", text: line });
      // What it decided for the person while they're away, and why: on their "While you were away".
      r.assumed.forEach((x, i) => (next = logged(next, { at: now() + i, kind: "assumed", text: x, ...(about ? { sid: about } : {}) })));
      r.forYou.forEach((q, i) => {
        asked.push({ at: now() + i, text: q, ...(about ? { sid: about } : {}) });
        next = logged(next, { at: now() + i, kind: "for-you", text: q, ...(about ? { sid: about } : {}) });
      });
      // Follow-ups it queues go in its queue on Run with queued starts on; otherwise they're suggestions for the person. A goal's
      // tasks are queued on Run whatever the switch says: they're the goal's plan, started once queued starts are on.
      const mayQueue = !mg && !missionMade && !cur.autonomy && cur.level === "run" && (cur.startQueued || !!goal);
      const suggest = [...r.next, ...(mayQueue ? [] : r.queue)];
      if (mayQueue)
        for (const q of r.queue) {
          if (next.queue.some((t) => t.text.toLowerCase() === q.toLowerCase())) continue;
          const added = enqueue(next, q, now(), goal);
          if (typeof added !== "string") (next = logged(added, { at: now(), kind: "said", text: `Queued: ${q.slice(0, 120)}` })), (queued = true);
        }
      if (r.learned.length || suggest.length) next = withNotes(next, r.learned, suggest, now());
      return next === cur ? null : next;
    });
    for (const a of asked) d.notify?.(m, { kind: "ask", ...a });
    // Ask waits for the person's Start; Merge and Run start it now.
    if (planMade) {
      const fresh = await d.managers.get(m.id);
      if (fresh && autonomyOf(fresh) !== "ask") await startPlan(fresh, planMade, { byYou: false }).catch((e: Error) => say(`[plans] start: ${e.message}`));
    }
    if (r.learned.length && d.learn) await d.learn(m, r.learned).catch((e: Error) => say(`[managers] learn: ${e.message}`));
    // Queued with the project quiet: it can start now.
    if (queued) {
      const fresh = await d.managers.get(m.id);
      if (fresh) await startQueued(fresh).catch(() => null);
      if (fresh && (pending || missionMade)) await runMissions(fresh).catch((e: Error) => say(`[missions] start: ${e.message}`));
    }
    if (pending && verdict) {
      const g = (await d.managers.get(m.id))?.goals?.find((x) => x.id === pending.goal);
      if (g) d.notify?.(m, { kind: "report", text: verdict.met ? `Mission done: ${g.title}` : `${g.title}: ${verdict.why || "not done yet"}`, sid: g.threads.at(-1)?.sid ?? "" });
    }
  };

  /** Its own turn now answers a message of the person's: what they said, by Captain id. */
  const replying = new Map<string, { text: string; at: number; done?: string; parallel?: number; budgetUsd?: number; prs?: boolean }>();
  /**
   * The person speaks to it (Arun, 2026-11-25: "talk to it"): their words in its conversation, and to its lane with what it may do
   * at its level. Like an answer, it goes even in quiet hours or past its budget: the person asked.
   */
  const sayTo = async (m: Manager, text: string, opts: { done?: string; parallel?: number; budgetUsd?: number; prs?: boolean } = {}): Promise<boolean> => {
    const t = text.trim().slice(0, 4000);
    if (!t) return false;
    const done = (opts.done ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    // What they said, with what done means when they said it, as their conversation shows it.
    // The chat never hangs at "Thinking…": no run on its lane within START_GUARD_MS of this, and it says why (timed from now, not
    // from after a slow start of its tool).
    const at = now();
    const ms = d.startGuardMs ?? START_GUARD_MS;
    if (ms > 0) (setTimeout(() => void startGuard(m.id, at).catch(() => {}), ms) as { unref?: () => void }).unref?.();
    // An earlier build's plans put away first, so they never stand in the way of what's asked now.
    await putAway(m.id);
    const next = await d.managers.update(m.id, (cur) => {
      const { stall: _s, ...rest } = withChat(cur, "you", done ? `${t}\n\nDone when ${done}` : t, now());
      return rest as Manager;
    });
    // Waiting for its reply from now: a restart of its tool that fails is then said at once (revive).
    replying.set(m.id, { text: t, at: now(), ...(done ? { done } : {}), ...(opts.parallel ? { parallel: opts.parallel } : {}), ...(opts.budgetUsd ? { budgetUsd: opts.budgetUsd } : {}), ...(opts.prs ? { prs: true } : {}) });
    let cur = await ensure(next ?? m);
    // Work to plan on the new flow is planned on its step-up model (planTurnHard): a big goal is worth one stronger turn.
    if (cur.autonomy && planTurnHard(t)) cur = await modelFor(cur, { hard: true } as Wake);
    // An earlier message of theirs still queued (its turn cut off by a restart and put back): taken back, so its old turn doesn't
    // run first and its answer isn't read as this one's. Its conversation, carried on, still has it.
    const earlier = await superseded(cur);
    if (earlier.length) say(`[managers] ${cur.project.name}: took back ${earlier.length} earlier message${earlier.length === 1 ? "" : "s"} cut off by a restart`);
    // Its planning turn told which tools are ready and how they rank for this ask, so it can spread the work across them.
    const tools = cur.autonomy && d.ranked ? await d.ranked(await d.me(), t).catch(() => [] as RankedTool[]) : [];
    const ok = await d.tell(cur.sid!, cur.lane!, cur.autonomy ? planSayText(cur, t, tools) : sayText(cur, t, done));
    return ok;
  };
  /**
   * Its lane hasn't started a run since the person's message at `at` (and hasn't replied): said in the chat once, and kept as its
   * stall, so its page shows it errored with why, until a run starts there. What it found, for the tests.
   */
  const guardRetried = new Set<string>();
  const startGuard = async (id: string, at: number): Promise<"ran" | "stalled" | "gone"> => {
    const m = await d.managers.get(id);
    if (!m?.sid || !m.lane) return "gone";
    if (!replying.has(id)) return "ran";
    const evs = await d.events(m.sid);
    if (evs.some((e) => (e.lane ?? MAIN_LANE) === m.lane && e.ts >= at && (e.body.type === "run.started" || e.body.type === "instructions.delivered" || (e.body.type === "agent.message" && e.actor.kind === "agent")))) return "ran";
    const st = await d.state(m.sid).catch(() => null);
    const e = st?.engines[m.lane];
    // Its tool gone since the message (marked only after the hub's grace): started again once, and given another while to run it.
    const failed = reviveWhy.get(id);
    if (e?.tool && !e.online && !(failed && failed.at >= at) && !guardRetried.has(`${id}:${at}`)) {
      guardRetried.add(`${id}:${at}`);
      if (await revive(id, m.sid, m.lane)) {
        const ms = d.startGuardMs ?? START_GUARD_MS;
        if (ms > 0) (setTimeout(() => void startGuard(id, at).catch(() => {}), ms) as { unref?: () => void }).unref?.();
        return "ran";
      }
    }
    const tool = TOOL_LABEL[e?.tool ?? m.tool] ?? m.tool;
    const why = reviveWhy.get(id)?.why ?? (!e?.tool ? "it has no coding tool on its lane" : !e.online ? `${tool} isn't attached and couldn't be started again` : `${tool} didn't pick up the message`);
    await markStall(id, tool, why);
    return "stalled";
  };
  /** Its stall written once: the chat line saying why, and `stall` for its page, until a run starts on its lane. */
  const markStall = (id: string, tool: string, why: string) =>
    d.managers.update(id, (cur) => (cur.stall ? null : withChat({ ...cur, stall: { at: now(), why } }, "captain", `Couldn't start ${tool} for the Captain: ${why}. Try again, or check ${tool} on this computer.`, now(), { kind: "update", tone: "failed", keep: true })));
  /** The person's earlier messages still queued on its lane, undelivered: taken back (Deps.withdraw), their words returned. */
  const superseded = async (m: Manager): Promise<string[]> => {
    if (!d.withdraw || !m.sid || !m.lane) return [];
    const st = await d.state(m.sid).catch(() => null);
    const queued = st ? (() => { try { return pendingFor(st, m.lane!); } catch { return [] as number[]; } })() : [];
    if (!queued?.length) return [];
    const evs = await d.events(m.sid);
    const out: string[] = [];
    for (const seq of queued) {
      const e = evs.find((x) => x.seq === seq);
      const text = e?.body.type === "instruction" ? e.body.text : "";
      const asked = /^\[Captain message\] The person says, about "[^"]*":\n([\s\S]*?)(?:\n\n|$)/.exec(text);
      if (!asked) continue;
      if (await d.withdraw(m.sid, m.lane, seq).catch(() => false)) out.push(asked[1]!.trim());
    }
    return out;
  };
  /** An earlier build's plans and agents put away (putAwayOld), said once in the chat; a new-flow Captain's rotate cleared. */
  const putAway = async (id: string) => {
    let titles: string[] = [];
    await d.managers.update(id, (cur) => {
      const r = putAwayOld(cur, now());
      if (!r) return null;
      titles = r.titles;
      return titles.length ? logged(update(r.m, `Put away an old plan from an earlier version: ${titles.join(", ")}.`, { tone: "info" }), { at: now(), kind: "said", text: `Put away ${titles.length} old plan${titles.length === 1 ? "" : "s"}` }) : r.m;
    });
    return titles.length;
  };
  /** A goal given up by the person: its queued tasks go; its threads are left as they are. */
  const cancelGoal = async (m: Manager, id: string): Promise<boolean> =>
    !!(await d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === id);
      if (!g || g.status === "cancelled" || g.status === "done") return null;
      return logged({ ...cur, queue: cur.queue.filter((q) => q.goal !== id), goals: cur.goals!.map((x) => (x.id === id ? { ...x, status: "cancelled" as const } : x)) }, { at: now(), kind: "said", text: `Goal given up: ${g.title}` });
    }));
  /** A goal's thread moved on (started, ready, shipped, stuck): its goal's status follows, and a goal now ready, done or stuck is said. */
  const goalMoved = async (m: Manager, sid: string, state: Goal["threads"][number]["state"]) => {
    let changed: Goal[] = [];
    await d.managers.update(m.id, (cur) => {
      if (!cur.goals?.some((g) => g.threads.some((t) => t.sid === sid))) return null;
      const r = goalsAfter(cur, sid, state);
      changed = r.changed;
      return changed.reduce((acc, g) => logged(acc, { at: now(), kind: "said", text: `Goal ${g.status === "ready" ? "ready to ship" : g.status}: ${g.title} (${goalLine(g)})`, sid }), r.m);
    });
    for (const g of changed) if (!g.mission && (g.status === "ready" || g.status === "stuck" || g.status === "done")) d.notify?.(m, { kind: "report", text: `${g.status === "ready" ? "Ready to ship" : g.status === "done" ? "Shipped" : "Stuck"}: ${g.title} · ${goalLine(g)}`, sid });
    // A mission's piece passed its check, and the person allowed pull requests: its thread opens one (never merges).
    const fresh = await d.managers.get(m.id);
    const mg = fresh?.goals?.find((g) => g.mission && g.threads.some((t) => t.sid === sid));
    if (fresh && mg?.mission?.prs && state === "ready" && !prAsked.has(sid)) {
      prAsked.add(sid);
      await d.instruct(sid, await d.me(), MISSION_PR_TEXT).catch((e: Error) => say(`[missions] pr: ${e.message}`));
    }
    // A mission whose work ran out: its done condition judged. Otherwise the next of its tasks may start in the room this one left.
    for (const g of changed) if (g.mission && g.status === "checking") await askMission(fresh ?? m, g.id, "judge").catch((e: Error) => say(`[missions] judge: ${e.message}`));
    if (fresh && mg) await runMissions(fresh).catch((e: Error) => say(`[missions] start: ${e.message}`));
  };

  // ── Captain v2 (docs/plans/captain-v2.md, Contract v1): its plans, run by agents of its own ─────────────────────────────────
  // Plain code decides everything here (Arun watches tokens): starting, reading a thread's end, retrying, blocking. The Captain's
  // turns go on the plan and on answering the person, not on bookkeeping.
  const planOf = (m: Pick<Manager, "plans">, pid: string) => m.plans?.find((p) => p.id === pid);
  /** An update in its chat about one of its agents' tasks. */
  // Kept (always shown): results, failures, asks, answers and what was brought in; the started and finished chatter folds away (the
  // UX review, 2026-11-27).
  const KEEP = /^(All \d+ done|Brought |Answered |Asked you|You answered|Plan cancelled|Put away|Revised|Couldn't|Running ".*" again|Skipped |Ready to bring|Waiting to bring)/;
  const update = (m: Manager, text: string, card: Omit<Extract<ChatCard, { kind: "update" }>, "kind">) =>
    withChat(m, "captain", text, now(), { kind: "update", ...card, ...(card.keep || card.tone === "failed" || card.tone === "needs" || KEEP.test(text) ? { keep: true as const } : {}) });
  /** Its asks about a plan put away (the plan ended, was cancelled, or its hold was answered); `holdOnly` for the hold alone. */
  const putAwayAsks = (m: Manager, pid: string, answer: string | null, holdOnly = false): Manager => {
    let out = m;
    for (const a of m.log) if (a.kind === "for-you" && !a.answered && !a.dismissed && (holdOnly ? a.hold?.pid === pid : a.plan === pid || a.hold?.pid === pid)) out = settleForYou(out, a.at, answer) ?? out;
    return out;
  };
  /**
   * The plan task an agent's lane is on, in any of the Captains' live or finished plans. Its agents are lanes in the Captain's own
   * session (Arun, 2026-11-27: "captains do not open threads… crew mates working together… no threads in the sidebar"), so a lane,
   * not a session, says whose an event is: the Captain's own lane stays the Captain's.
   */
  const planThread = (list: readonly Manager[], sid: string, lane?: string): { m: Manager; plan: Plan; task: PlanTask } | null => {
    for (const m of list) for (const plan of m.plans ?? []) for (const task of plan.tasks) if (task.sid === sid && task.lane && (lane === undefined || task.lane === lane)) return { m, plan, task };
    return null;
  };
  /** One task and its agent changed together, under the lock; null when the plan or task is gone. */
  const changeTask = (id: string, pid: string, tid: string, fn: (cur: Manager, plan: Plan, task: PlanTask, agent: CaptainAgent | undefined) => Manager | null) =>
    d.managers.update(id, (cur) => {
      const plan = planOf(cur, pid);
      const task = plan?.tasks.find((t) => t.id === tid);
      return plan && task ? fn(cur, plan, task, cur.agents?.find((a) => a.id === task.agent)) : null;
    });
  const withTask = (plan: Plan, tid: string, patch: Partial<PlanTask>): Plan => ({ ...plan, tasks: plan.tasks.map((t) => (t.id === tid ? { ...t, ...patch } : t)) });
  const withAgent = (m: Manager, aid: string | undefined, patch: Partial<CaptainAgent>): Manager => (aid && m.agents?.some((a) => a.id === aid) ? { ...m, agents: m.agents.map((a) => (a.id === aid ? { ...a, ...patch } : a)) } : m);
  const nameOfAgent = (m: Pick<Manager, "agents">, t: Pick<PlanTask, "agent" | "role">) => m.agents?.find((a) => a.id === t.agent)?.name ?? t.role;
  /** An agent's last words on its lane. */
  const lastSaid = (evs: readonly SessionEvent[], lane: string) =>
    ((e) => (e ? ((e.body as { text?: string }).text ?? "") : ""))(evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent"));

  /**
   * Turns asked of the Captain about its plans, by Captain id, read back from its next reply (heardReply): an agent's question, a
   * revision of what's left after a failure, the summary once it's all done. Each keeps the words it was told, so a turn that ended
   * before it got them doesn't count as the answer.
   */
  const agentAsks = new Map<string, { pid: string; tid: string; q: string; told: string; at: number }>();
  const replanAsks = new Map<string, { pid: string; why: string; told: string }>();
  const reportAsks = new Map<string, { pid: string; told: string }>();
  /** Plans whose criteria Friday is running checks for (judged): not judged lost meanwhile. */
  const proving = new Set<string>();
  /** Plans whose Captain was asked once to prove a verdict it called met (proveText). */
  const reproved = new Set<string>();
  /** Finished rounds whose lost judging turn was asked again after a restart (recoverPlans), and when. */
  const rejudged = new Map<string, number>();
  /** Whether the turn that just ended on its lane had `told` (begun after it, or handed it mid-turn). */
  const sawIt = (evs: readonly SessionEvent[], lane: string, told: string) => {
    const at = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && (e.body as { text?: string }).text === told);
    if (!at) return true;
    const start = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
    return !!start && (start.seq > at.seq || evs.some((e) => e.seq > start.seq && e.body.type === "instructions.delivered" && e.body.seqs.includes(at.seq)));
  };
  /**
   * The Captain woken about its plan, on its own lane, within its budget (on, out of quiet hours, wakes left): on its step-up model
   * only when it's hard (a revision). Whether it was told.
   */
  const wakeCaptain = async (m: Manager, text: string, hard: boolean): Promise<boolean> => {
    if (!mayWake(m, undefined, now()).ok) return false;
    let cur = await ensure(m);
    cur = await modelFor(cur, { hard } as Wake);
    const ok = await d.tell(cur.sid!, cur.lane!, text);
    if (ok) await d.managers.update(m.id, (x) => countWake(x, now()));
    return ok;
  };
  /** Why it can't be woken now, in a few words, or "". */
  const whyNot = (m: Manager) => ((w) => (w.ok ? "" : w.why === "off" ? "it's off" : w.why.toLowerCase()))(mayWake(m, undefined, now()));
  /** An agent's question brought to the person: a "For you" on its lane, a line in the chat, their phone. */
  const askYou = async (id: string, pid: string, tid: string, text: string) => {
    let at = 0;
    const next = await changeTask(id, pid, tid, (cur, _p, t, a) => {
      at = now();
      const m1 = logged(withAgent(cur, a?.id, { status: "needs" }), { at, kind: "for-you", text, ...(t.sid ? { sid: t.sid } : {}), ...(t.lane ? { lane: t.lane } : {}), plan: pid, keep: true });
      return update(m1, `Asked you: ${text}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "needs" });
    });
    const t = next && planOf(next, pid)?.tasks.find((x) => x.id === tid);
    if (next && t) d.notify?.(next, { kind: "ask", at, text, ...(t.sid ? { sid: t.sid } : {}) });
  };
  /**
   * One of its agents asks something (its ask card, or a question at its turn's end): the Captain is woken on its own lane to answer
   * within the plan, or bring it to the person. Past its budget, in quiet hours, or already on another agent's question: straight to
   * the person, said why.
   */
  const askCaptain = async (m0: Manager, plan: Plan, task: PlanTask, q: string) => {
    const m = (await d.managers.get(m0.id)) ?? m0;
    const name = nameOfAgent(m, task);
    await changeTask(m.id, plan.id, task.id, (cur, _p, _t, a) => (a?.status === "needs" ? null : withAgent(cur, a?.id, { status: "needs" })));
    // One question at a time; one it never answered (a lost turn) stops counting after ASK_AGAIN_MS.
    const busy = agentAsks.get(m.id);
    if (busy && now() - busy.at >= ASK_AGAIN_MS) agentAsks.delete(m.id);
    const why = agentAsks.has(m.id) ? "the Captain is on another question" : whyNot(m);
    if (!why) {
      const evs = await d.events(task.sid!);
      const ask = m.goals?.find((g) => g.id === plan.goal)?.ask ?? "";
      const a = m.agents?.find((x) => x.id === task.agent) ?? { name, role: task.role };
      const told = agentAskText(m, plan, task, a, q, lastSaid(evs, task.lane!), ask);
      agentAsks.set(m.id, { pid: plan.id, tid: task.id, q, told, at: now() });
      if (await wakeCaptain(m, told, false).catch(() => false)) return;
      agentAsks.delete(m.id);
    }
    await askYou(m.id, plan.id, task.id, `${name} asks: ${q}${why ? ` (${why})` : ""}`);
  };

  /**
   * A plan started: a draft approved by the person (optionally with its tasks edited), or by itself when its autonomy doesn't
   * ask. Then whatever may start, starts. Why not, otherwise.
   */
  const startPlan = async (m: Manager, pid: string, o: { tasks?: unknown; byYou?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string; status: number }> => {
    let why: { error: string; status: number } | null = null;
    const next = await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan) return (why = { error: "That plan isn't there any more.", status: 404 }), null;
      if (plan.status !== "draft") return (why = { error: "That plan has started already.", status: 409 }), null;
      let tasks = plan.tasks;
      if (o.tasks !== undefined) {
        const e = editTasks(plan, o.tasks);
        if (typeof e === "string") return (why = { error: e, status: 400 }), null;
        tasks = e;
      }
      const title = cur.goals?.find((g) => g.id === plan.goal)?.title ?? "a plan";
      return logged(withPlan(cur, { ...plan, status: "running", tasks }), { at: now(), kind: "said", text: `${o.byYou ? "You started" : "Started"} the plan: ${title}` });
    });
    if (!next) return { ok: false, ...(why ?? { error: "Couldn't start it.", status: 400 }) };
    await advance(next, pid, !!o.byYou);
    return { ok: true };
  };

  /**
   * The tasks of a running plan that may start, started: each for an agent of its own, on a lane of its own. Copies that what's next
   * waits on are brought together first. Out of quiet hours (unless the person just pressed Start or Go); near a tool's usage limit,
   * one at a time. How many started.
   */
  const advance = async (m: Manager, pid: string, byYou = false): Promise<number> => {
    if (!byYou && inQuiet(m, now())) return 0;
    const had = planOf((await d.managers.get(m.id)) ?? m, pid);
    if (!had || had.status !== "running") return 0;
    const bring = toBring(withBlocked(had));
    const merged = bring.length ? await bringTogether(m.id, pid, bring, byYou) : false;
    let picks: PlanTask[] = [];
    let busy = 0;
    await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan || plan.status !== "running") return null;
      const settled = withBlocked(plan);
      picks = readyTasks(settled);
      busy = settled.tasks.filter((t) => t.status === "running" || t.status === "checking").length;
      if (!picks.length) return settled === plan ? null : withPlan(cur, settled);
      // Taken under the lock, so two ends at once never start a task twice.
      return withPlan(cur, { ...settled, tasks: settled.tasks.map((t) => (picks.some((x) => x.id === t.id) ? { ...t, status: "running" as const, started: now(), tries: t.tries + 1 } : t)) });
    });
    const me = await d.me();
    let n = 0;
    for (const [i, task] of picks.entries()) {
      // Every agent in a copy of its own, made from the project folder as it is now (what was brought together carried in), so
      // none holds the folder the Captain's lane is on, nor writes where the person works (the audit, 2026-11-27: a Tester after a
      // merge couldn't start there); its work comes back by bringTogether.
      if (await startTask(m.id, pid, task, me, { copy: true, alone: busy + i === 0 })) n++;
    }
    // Brought together with nothing left to start: the plan may be done now.
    if (merged && !picks.length) await settle(m.id, pid);
    return n;
  };

  /** Waits said once, by `${pid}:${who}`. */
  const waitTold = new Set<string>();
  /**
   * Who is working in the project folder itself right now (a lane on it, not a copy of it, running), the Captain's own lane aside:
   * its title, or "". Bringing work in waits for them.
   */
  const folderBusy = async (m: Manager): Promise<string> => {
    const norm = (f: string) => f.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/private\//, "/");
    const home = norm(m.project.folder);
    const sids = [...new Set([...(m.sid ? [m.sid] : []), ...(await d.sessions(await d.me()).catch(() => [] as string[]))])];
    for (const sid of sids) {
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      for (const [lane, e] of Object.entries(st.engines)) {
        if (sid === m.sid && lane === (m.lane ?? MAIN_LANE)) continue;
        if (e.copyOf || !e.cwd || norm(e.cwd) !== home || statusAt(st, lane) !== "running") continue;
        return st.title || st.lanes.find((l) => l.id === lane)?.name || "an agent";
      }
    }
    return "";
  };
  /**
   * Done tasks' copies brought into the project folder (Arun, 2026-11-27: "agentic… finish to the very end"), in plan order, so what
   * comes next starts on their work and the final check sees it all. On Ask or Merge it waits for the person's Go first (plan.hold).
   * Conflict markers left: a Merger's task to resolve them, which what waited on those copies now waits on. A copy that couldn't be
   * brought over is the person's. Whether anything was brought over.
   */
  const bringTogether = async (id: string, pid: string, tasks: readonly PlanTask[], byYou: boolean): Promise<boolean> => {
    // One at a time per plan: the tick and a step's end can both get here, and two would apply the same copies twice (the audit,
    // 2026-11-28).
    if (bringing.has(pid)) return false;
    bringing.add(pid);
    try {
      return await bringNow(id, pid, tasks, byYou);
    } finally {
      bringing.delete(pid);
    }
  };
  const bringing = new Set<string>();
  /** Checks run once more after going quiet, by plan id (the whole) or `${sid}:${lane}:${endSeq}` (a step). */
  const rechecked = new Set<string>();
  /** Steps put back, by `${pid}:${tid}:${why}`, said once. */
  const backTold = new Set<string>();
  const bringNow = async (id: string, pid: string, tasks: readonly PlanTask[], byYou: boolean): Promise<boolean> => {
    const m = await d.managers.get(id);
    const plan = m && planOf(m, pid);
    if (!m || !plan) return false;
    const names = [...new Set(tasks.map((t) => nameOfAgent(m, t)))].join(", ");
    // Never while someone works in the project folder itself (an agent of the person's there): the next look tries again.
    const busyIn = await folderBusy(m);
    if (busyIn) {
      if (!waitTold.has(`${pid}:${busyIn}`)) {
        waitTold.add(`${pid}:${busyIn}`);
        await d.managers.update(id, (cur) => update(cur, `Waiting to bring ${names}'s work together: "${busyIn}" is working in the project folder.`, { tone: "info" }));
      }
      return false;
    }
    if (autonomyOf(m) !== "run" && !byYou && !plan.approved) {
      // Already waiting for the Go: more work joins what it will bring, said once.
      if (plan.hold) {
        const more = tasks.map((t) => t.id).filter((x) => !plan.hold!.tasks.includes(x));
        if (more.length) await d.managers.update(id, (cur) => ((p) => (p?.hold ? withPlan(cur, { ...p, hold: { ...p.hold, tasks: [...p.hold.tasks, ...more] } }) : null))(planOf(cur, pid)));
        return false;
      }
      const text = `Ready to bring ${names}'s work together into the project folder. Give it the go when you're ready.`;
      const at = now();
      const next = await d.managers.update(id, (cur) => {
        const p = planOf(cur, pid);
        if (!p || p.hold) return null;
        return logged(update(withPlan(cur, { ...p, hold: { kind: "merge", tasks: tasks.map((t) => t.id), at } }), text, { tone: "needs" }), { at, kind: "for-you", text, ...(tasks[0]?.sid ? { sid: tasks[0].sid } : {}), plan: pid, keep: true, hold: { pid, kind: "merge", lanes: tasks.flatMap((t) => (t.lane ? [t.lane] : [])) } });
      });
      if (next && tasks[0]?.sid) d.notify?.(next, { kind: "ask", at, text, sid: tasks[0].sid });
      return false;
    }
    const conflicts: string[] = [];
    const failed: { who: string; why: string }[] = [];
    /** Steps whose copy didn't come over: never marked brought in (so nothing builds on it, and Stop never deletes it). */
    const notIn = new Set<string>();
    const paths = new Set<string>();
    // The branch the project folder is on, as its Captain's lane there reports it, so the line says where the work went.
    const branch = m.sid && m.lane ? (await d.state(m.sid).catch(() => null))?.engines[m.lane]?.branch : undefined;
    let files = 0;
    for (const t of plan.tasks.filter((x) => tasks.some((y) => y.id === x.id))) {
      if (!t.sid || !t.lane) continue;
      // Which files, as its lane's diff has them, for the line that says what came in.
      const st = await d.state(t.sid).catch(() => null);
      for (const f of st?.diffs?.[t.lane]?.files ?? []) paths.add(f.path);
      if (!d.apply) {
        failed.push({ who: nameOfAgent(m, t), why: "bringing work together isn't available here" });
        notIn.add(t.id);
        continue;
      }
      try {
        // Its copy is brought over by its own lane's runner, which leaves once the agent is done (a restart, or the tool closed):
        // started again first, and waited for, rather than failing with "isn't connected" for a folder on this very Mac (Arun,
        // 2026-11-28: three finished agents' work couldn't come over).
        const r = await d.apply(t.sid, t.lane).catch(async (e: Error) => {
          if (!/isn't connected|not connected|stopped working in this folder/i.test(e.message) || !(await reattach(m.id, t.sid!, t.lane!))) throw e;
          return d.apply!(t.sid!, t.lane!);
        });
        files += r.files;
        conflicts.push(...r.conflicts);
      } catch (e) {
        failed.push({ who: nameOfAgent(m, t), why: clip((e as Error).message, 200) });
        notIn.add(t.id);
      }
    }
    const ids = tasks.map((t) => t.id).filter((x) => !notIn.has(x));
    const files2 = [...new Set(conflicts)];
    let asked = "";
    const next = await d.managers.update(id, (cur) => {
      const p = planOf(cur, pid);
      if (!p) return null;
      const { hold: _h, ...rest } = p;
      let np: Plan = { ...rest, tasks: p.tasks.map((t) => (ids.includes(t.id) ? { ...t, applied: true as const } : notIn.has(t.id) ? { ...t, bringFailed: true as const } : t)) };
      if (files2.length) np = withMerger(np, ids, files2, now());
      const said = files2.length
        ? `Brought ${names}'s work together; it left conflicts in ${files2.slice(0, 6).join(", ")}${files2.length > 6 ? ` and ${files2.length - 6} more` : ""}, so an Integrator resolves them first.`
        : `Brought ${names}'s work into the project folder${branch ? ` (on ${branch})` : ""}${paths.size ? `: ${[...paths].slice(0, 8).join(", ")}${paths.size > 8 ? ` and ${paths.size - 8} more` : ""}` : files ? ` (${files} file${files === 1 ? "" : "s"})` : ""}. Nothing is committed: look it over before you ship.`;
      let out = update(withPlan(cur, np), said, { tone: files2.length ? "needs" : "info" });
      if (failed.length) {
        // One line per reason, not the same reason after every name.
        const by = new Map<string, string[]>();
        for (const f of failed) by.set(f.why, [...(by.get(f.why) ?? []), f.who]);
        const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
        asked = `Couldn't bring over ${[...by].map(([why, who]) => `${list(who)}'s work: ${why.replace(/\.$/, "")}`).join(". ")}. Bring it over from the lane yourself, or cancel the plan.`;
        out = logged(update(out, asked, { tone: "failed" }), { at: now(), kind: "for-you", text: asked });
      }
      return logged(out, { at: now(), kind: "said", text: said });
    });
    if (next && asked) d.notify?.(next, { kind: "ask", at: now(), text: asked, ...(tasks[0]?.sid ? { sid: tasks[0].sid } : {}) });
    return true;
  };

  /** The person's Go on work held to be brought together (plan.hold), then whatever may start. */
  const goBring = async (m: Manager, pid: string): Promise<boolean> => {
    const plan = planOf((await d.managers.get(m.id)) ?? m, pid);
    if (!plan?.hold || plan.status !== "running") return false;
    // Its "For you" about it is answered by the Go.
    await d.managers.update(m.id, (cur) => {
      const a = cur.log.find((x) => x.kind === "for-you" && (x.hold?.pid === pid || x.at === plan.hold!.at) && !x.answered && !x.dismissed);
      return a ? putAwayAsks(settleForYou(cur, a.at, "Go") ?? cur, pid, "Go", true) : null;
    });
    // The Go is for this plan: what comes after comes over without asking again.
    await d.managers.update(m.id, (cur) => ((p) => (p ? withPlan(cur, { ...p, approved: true }) : null))(planOf(cur, pid)));
    const bring = plan.tasks.filter((t) => plan.hold!.tasks.includes(t.id) && t.status === "done" && t.copy && !t.applied);
    await bringTogether(m.id, pid, bring, true);
    await advance((await d.managers.get(m.id)) ?? m, pid, true);
    // Nothing left to start (the last copies came over): the plan may be done now, so it's checked and finished.
    await settle(m.id, pid);
    return true;
  };

  /**
   * One task started for an agent (a saved one with its role, or a fresh one): its coding tool on a new lane named for it in the
   * Captain's own session (hidden from the sidebar), in its own copy when others run at once, then briefed on that lane.
   */
  const startTask = async (id: string, pid: string, task: PlanTask, me: Me, o: { copy: boolean; alone: boolean }): Promise<boolean> => {
    // Put back; said once per reason for the step, not on every minute's try (the audit, 2026-11-28).
    const back = (text: string) =>
      changeTask(id, pid, task.id, (cur, plan) => {
        const k = `${pid}:${task.id}:${text}`;
        const np = withPlan(cur, withTask(plan, task.id, { status: "queued", tries: task.tries }));
        if (backTold.has(k)) return np;
        backTold.add(k);
        return logged(np, { at: now(), kind: "skipped", text });
      });
    const had = await d.managers.get(id);
    const plan0 = had && planOf(had, pid);
    if (!had || !plan0 || plan0.status !== "running") return false;
    // This start's own mark: a slow start that recoverPlans put back and the tick started again isn't taken by both.
    const startedAt = plan0.tasks.find((x) => x.id === task.id)?.started;
    // A saved agent for the role, unless the Captain chose another tool for this step.
    const saved = ((a) => (a && (!task.tool || a.tool === task.tool) ? a : undefined))(rosterAgent(had.agents, task.role));
    const pick = saved ? { tool: saved.tool, ...(saved.model ? { model: saved.model } : {}), why: "saved for this role" } : await chooseCrew(had, plan0, task, me);
    if (!pick) return void (await back("No coding tool is ready to start the plan's next task")), false;
    // Near its tool's usage limit, tasks don't run at once: each would spend it as fast.
    if (!o.alone && d.nearLimit && (await d.nearLimit(pick.tool).catch(() => false))) return void (await back(`${TOOL_LABEL[pick.tool] ?? pick.tool} is near its usage limit: one task at a time`)), false;
    try {
      const cur = await ensure(had);
      const plan = planOf(cur, pid) ?? plan0;
      const sid = cur.sid!;
      // A saved agent taken by another task meanwhile: this one gets a fresh agent instead.
      const fresh = await d.managers.get(id);
      const taken = saved && fresh?.agents?.some((a) => a.id === saved.id && (a.status === "working" || a.status === "needs"));
      const agent: CaptainAgent = { ...(saved && !taken ? saved : newAgent(fresh ?? cur, task.role, pick.tool, agentModel(pick.tool, pick.model, task.role), now())), ...(pick.why ? { why: pick.why } : {}) };
      // A saved agent's last lane, from its last task, has its tool stopped: it goes on in a new one (its work there is kept).
      if (agent.saved && agent.sid && agent.lane) await d.stop(agent.sid, me, agent.lane).catch(() => {});
      const { lane: got } = await d.startTool(sid, me, { tool: pick.tool, cwd: cur.project.folder, project: cur.project.name, newLane: agent.name.slice(0, 40), ...(o.copy ? { copy: true } : {}), ...(agent.model ? { model: agent.model } : {}) });
      const lane = got || MAIN_LANE;
      const took = await changeTask(id, pid, task.id, (c, p, t) => {
        // Cancelled, stopped or put back while its tool was starting: the lane isn't the step's, and is stopped below (the audit,
        // 2026-11-28: an orphan agent spent all night).
        if (p.status !== "running" || t.status !== "running" || t.lane || t.started !== startedAt) return null;
        const live = { ...agent, sid, lane, status: "working" as const, task: task.id };
        const agents = c.agents?.some((a) => a.id === agent.id) ? c.agents.map((a) => (a.id === agent.id ? live : a)) : [...(c.agents ?? []), live];
        const next = withPlan({ ...c, agents }, withTask(p, task.id, { sid, lane, agent: agent.id, ...(o.copy ? { copy: true as const } : {}) }));
        return logged(update(next, `${agent.name} started: ${task.text}`, { agent: agent.id, task: task.id, tone: "info" }), { at: now(), kind: "started", text: `${agent.name} started "${task.text.slice(0, 80)}" on ${TOOL_LABEL[pick.tool] ?? pick.tool}${pick.why ? `: ${pick.why}` : ""}`, sid, lane });
      });
      if (!took) {
        await d.stop(sid, me, lane).catch(() => {});
        return false;
      }
      // Briefed once its lane is the task's, so whatever it does from here is read as the task's.
      const goal = cur.goals?.find((g) => g.id === plan.goal);
      const ask = goal?.ask ?? "";
      // A judge of two attempts reads both as they are, in their copies (judgeBrief); everyone else gets the task's brief.
      const brief = task.judge ? await judgeText(cur, plan, task, agent, ask) : taskBrief(cur, plan, task, agent, ask, o.copy, goal);
      await d.tell(sid, lane, brief);
      return true;
    } catch (e) {
      const err = clip((e as Error).message, 600);
      say(`[plans] start: ${err}`);
      await changeTask(id, pid, task.id, (c, p) => update(withPlan(c, withTask(p, task.id, { status: "failed", ended: now(), result: `Couldn't start: ${err}` })), `Couldn't start "${task.text}": ${err}`, { task: task.id, tone: "failed" }));
      await settle(id, pid);
      return false;
    }
  };

  /**
   * Its reply read for the plan turns it was asked for, each only if that turn had the words it was told. Says "revised" when a
   * revision was applied (its plan block isn't a new plan then).
   */
  const planTurns = async (m: Manager, evs: readonly SessionEvent[], lane: string, said: string, r: ReturnType<typeof readReply>): Promise<"revised" | ""> => {
    let out: "revised" | "" = "";
    const aq = agentAsks.get(m.id);
    if (aq && sawIt(evs, lane, aq.told)) {
      agentAsks.delete(m.id);
      await answered(m, aq, said, r).catch((e: Error) => say(`[plans] answer: ${e.message}`));
    }
    const rq = replanAsks.get(m.id);
    if (rq && sawIt(evs, lane, rq.told)) {
      replanAsks.delete(m.id);
      if (await revised(m, rq, said, r).catch((e: Error) => (say(`[plans] revise: ${e.message}`), false))) out = "revised";
    }
    const pq = reportAsks.get(m.id);
    if (pq && sawIt(evs, lane, pq.told)) {
      reportAsks.delete(m.id);
      await judged(m, pq.pid, said).catch((e: Error) => say(`[plans] judge: ${e.message}`));
    }
    return out;
  };

  /**
   * The Captain's judgement of a finished round (reportText): its verdict and criteria, its assumptions and its summary kept on the
   * plan; not met with more steps planned and rounds left, the next round starts as a plan of the same goal (Arun, 2026-11-28: "set
   * this goal up and wake up to finished work with proof"); otherwise the goal is finished, goes out as the settings say
   * (shipGoal), and the person is told the morning report is ready.
   */
  const judged = async (m: Manager, pid: string, said: string) => {
    // Phase 3, proof produced by Friday: each criterion's check (the Captain's "(check: …)", or its brief's) run by Friday itself on
    // the work in the project folder before anything is decided, at most CHECKS_MAX, in the background (a test run takes minutes).
    const v0 = verdictOf(said);
    const plan0 = planOf(m, pid);
    const goal = plan0 ? m.goals?.find((g) => g.id === plan0.goal) : undefined;
    const jobs = (v0?.criteria ?? []).flatMap((c, i) => ((cmd) => (cmd ? [{ i, cmd }] : []))(c.check ?? checkFor(goal, c.text))).slice(0, CHECKS_MAX);
    if (!jobs.length || !d.run || !m.sid) return judge(m, pid, said, new Map());
    proving.add(pid);
    void (async () => {
      const res = new Map<number, { cmd: string; ok: boolean; out?: string }>();
      for (const j of jobs) {
        const r = await d.run!(m.sid!, m.lane ?? MAIN_LANE, j.cmd).catch((e: Error) => ({ ok: false, out: `Couldn't run it: ${e.message}` }));
        if (r) res.set(j.i, { cmd: j.cmd, ok: r.ok, ...(r.out ? { out: clip(r.out, 600) } : {}) });
      }
      const pass = [...res.values()].filter((x) => x.ok).length;
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Friday ran ${res.size} check${res.size === 1 ? "" : "s"} itself: ${pass} pass${res.size - pass ? `, ${res.size - pass} fail` : ""}` }));
      await judge((await d.managers.get(m.id)) ?? m, pid, said, res);
    })()
      .catch((e: Error) => say(`[plans] proof: ${e.message}`))
      .finally(() => proving.delete(pid));
  };
  /** The Captain's judgement applied, with Friday's own check results by criterion (judged). */
  const judge = async (m: Manager, pid: string, said: string, ran: ReadonlyMap<number, { cmd: string; ok: boolean; out?: string }>) => {
    const rr = readReply(said);
    const v1 = verdictOf(said);
    const said0 = v1 && ran.size ? { ...v1, criteria: v1.criteria?.map((c, i) => (ran.has(i) ? { ...c, friday: ran.get(i)! } : c)) } : v1;
    const p = parsePlan(said);
    const plan0 = planOf(m, pid);
    // An unproved criterion can't show as done, nor a goal whose check of the whole fails (provenVerdict).
    const verdict = said0 && provenVerdict(said0, plan0?.final);
    // Called met but the proof didn't hold, nothing more planned: asked once to prove it or plan the rest, before it goes out.
    if (verdict && said0!.met && !verdict.met && !p.tasks.length && plan0 && (plan0.round ?? 1) <= ROUNDS_MAX && !reproved.has(pid)) {
      reproved.add(pid);
      const title = m.goals?.find((g) => g.id === plan0.goal)?.title ?? "The plan";
      const told = proveText(title, verdict, plan0.final);
      await d.managers.update(m.id, (cur) => { const pl = planOf(cur, pid); return pl ? withPlan(cur, { ...pl, verdict }) : null; });
      reportAsks.set(m.id, { pid, told });
      if (await wakeCaptain(m, told, false).catch(() => false)) return;
      reportAsks.delete(m.id);
    }
    let nextPid = "";
    const out = await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan) return null;
      const round = plan.round ?? 1;
      const text = rr.reply || rr.prose.replace(/^(verdict|assumed)\s*:.*$/gim, "").replace(/^\[[ xX✓]\].*$/gm, "").trim();
      const assumed = rr.assumed.slice(0, 12);
      let next = withPlan(cur, { ...plan, ...(text ? { report: text } : {}), ...(verdict ? { verdict } : {}), ...(assumed.length ? { assumed } : {}) });
      if (text) next = withChat(next, "captain", text, now(), { kind: "update", tone: "done", keep: true });
      for (const [i, a] of assumed.entries()) next = logged(next, { at: now() + i, kind: "assumed", text: a });
      // Another round: not met, steps planned, rounds left.
      if (verdict && !verdict.met && p.tasks.length && round < ROUNDS_MAX) {
        const np = { ...makePlan(`p_${randomBytes(4).toString("hex")}`, plan.goal, withReview(p.tasks, cur.goals?.find((g) => g.id === plan.goal)?.ask ?? ""), now()), round: round + 1 };
        nextPid = np.id;
        const why = verdict.why ? `Not done yet: ${verdict.why}. ` : "Not done yet. ";
        next = logged(withChat(withPlan(next, np), "captain", `${why}Round ${round + 1}: ${p.tasks.length} more step${p.tasks.length === 1 ? "" : "s"}.`, now(), { kind: "plan", plan: np.id }), { at: now(), kind: "said", text: `Round ${round + 1} of ${p.title || "the goal"} (${p.tasks.length} task${p.tasks.length === 1 ? "" : "s"})` });
      }
      return next;
    });
    if (!out) return;
    if (nextPid) {
      if (autonomyOf(out) !== "ask") await startPlan(out, nextPid, { byYou: false }).catch((e: Error) => say(`[plans] next round: ${e.message}`));
      return;
    }
    await shipGoal(m.id, pid);
  };

  /**
   * A finished goal out as its Captain's settings say (Manager.ship): left in the folder; committed to a friday/ branch on this Mac
   * (only the files its crew changed, never the person's own work in the folder); that branch pushed; or a pull request opened. A
   * push or pull request only when the check of the whole didn't fail. Never merged. Then the morning report is said, on the phone too.
   */
  const shipGoal = async (id: string, pid: string) => {
    const m = await d.managers.get(id);
    const plan = m && planOf(m, pid);
    if (!m || !plan || plan.shipped) return;
    const goal = m.goals?.find((g) => g.id === plan.goal);
    const title = goal?.title ?? "The plan";
    const how: ShipHow = m.ship ?? "folder";
    // Every round of the goal: their files, and whether any round's check failed.
    const rounds = (m.plans ?? []).filter((x) => x.goal === plan.goal);
    let shipped: Plan["shipped"] = { how, at: now() };
    if (how !== "folder" && d.ship && m.sid && m.lane) {
      const only = new Set<string>();
      for (const t of rounds.flatMap((x) => x.tasks).filter((t) => t.applied && t.sid && t.lane)) {
        const st = await d.state(t.sid!).catch(() => null);
        for (const f of st?.diffs?.[t.lane!]?.files ?? []) {
          only.add(f.path);
          if ((f as { from?: string }).from) only.add((f as { from?: string }).from!);
        }
      }
      const failed = rounds.some((x) => x.final?.status === "failed");
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "goal";
      const branch = `friday/${slug}-${pid.slice(-4)}`;
      const v = plan.verdict;
      const body = [plan.report ?? "", v?.criteria?.length ? `Criteria:\n${v.criteria.map((c) => `- [${c.ok ? "x" : " "}] ${c.text}${c.proof ? `: ${c.proof}` : ""}`).join("\n")}` : "", "Made by a Friday Captain's crew."].filter(Boolean).join("\n\n");
      if (!only.size) shipped = { ...shipped, error: "Nothing of the crew's to commit." };
      else {
        const r = await d.ship(m.sid, m.lane, { how: failed && how !== "branch" ? "branch" : how, branch, title, body, only: [...only] }).catch((e: Error) => ({ error: e.message }) as Awaited<ReturnType<NonNullable<typeof d.ship>>>);
        shipped = { ...shipped, ...r, ...(failed && how !== "branch" && !r.error ? { error: "The check of the whole failed, so it was committed to its branch but not pushed." } : {}) };
      }
    }
    const next = await d.managers.update(id, (cur) => ((p) => (p ? withPlan(cur, { ...p, shipped }) : null))(planOf(cur, pid)));
    const where = shipped.prUrl ? `pull request open: ${shipped.prUrl}` : shipped.pushed ? `pushed to ${shipped.branch}` : shipped.sha ? `committed to ${shipped.branch}` : shipped.error ? `left in your folder (${shipped.error})` : "in your folder, not committed";
    const met = plan.verdict ? (plan.verdict.met ? "Done" : "Done with notes") : "Finished";
    const sid = plan.tasks.find((t) => t.sid)?.sid;
    if (next && sid) d.notify?.(next, { kind: "report", text: `${met}: ${title}, ${where}. The report is ready.`, sid });
    if (next) await d.managers.update(id, (cur) => update(cur, `${met}: ${title}, ${where}. Open Recap for the report and its proof.`, { tone: "done" }));
  };

  /** Its answer to an agent's question passed to the agent's lane; no answer, it's the person's (its "For you", or the question). */
  const answered = async (m: Manager, aq: { pid: string; tid: string; q: string }, said: string, r: ReturnType<typeof readReply>) => {
    const cur = await d.managers.get(m.id);
    const plan = cur && planOf(cur, aq.pid);
    const task = plan?.tasks.find((t) => t.id === aq.tid);
    if (!cur || !plan || plan.status !== "running" || !task || task.status !== "running" || !task.sid || !task.lane) return;
    const name = nameOfAgent(cur, task);
    const ans = answerOf(said);
    if (ans) {
      await tellLane(task.sid, task.lane, `[Captain] ${ans}`);
      await changeTask(cur.id, plan.id, task.id, (c, _p, t, a) =>
        logged(update(withAgent(c, a?.id, { status: "working" }), `Answered ${name}: ${ans}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "info" }), { at: now(), kind: "said", text: `Answered ${name}: ${clip(ans, 200)}`, sid: t.sid!, lane: t.lane! }),
      );
      return;
    }
    const text = r.forYou.length ? `${name} asks: ${aq.q} ${r.forYou.join(" ")}` : `${name} asks: ${aq.q}`;
    // Said here, on the agent's lane: not again by the reply's own "For you" handling.
    r.forYou.length = 0;
    await askYou(cur.id, plan.id, task.id, text);
  };

  /** Its revision of what's left applied as the plan's next revision (a draft again on Ask); none, and it's the person's. */
  const revised = async (m: Manager, rq: { pid: string; why: string }, said: string, r: ReturnType<typeof readReply>): Promise<boolean> => {
    const cur = await d.managers.get(m.id);
    const plan = cur && planOf(cur, rq.pid);
    if (!cur || !plan || plan.status !== "running") return false;
    const p = parsePlan(said);
    if (!p.tasks.length) {
      // No revision: one ask, with what it said instead.
      const extra = r.forYou.length ? r.forYou.join(" ") : "I couldn't find another way to do it";
      r.forYou.length = 0;
      await d.managers.update(m.id, (c) => ((pl) => (pl?.revising ? withPlan(c, (({ revising: _r, ...rest }) => rest)(pl)) : null))(planOf(c, rq.pid)));
      await askHeld(m.id, plan, rq.why, extra);
      return false;
    }
    const rr = readReply(p.rest);
    const ask = autonomyOf(cur) === "ask";
    let rev = 0;
    await d.managers.update(m.id, (c) => {
      const pl = planOf(c, rq.pid);
      if (!pl || pl.status !== "running") return null;
      const np = revisePlan(pl, p.tasks, rq.why, now());
      rev = np.revision!;
      const words = rr.reply || rr.prose || "Here's what's left, revised.";
      const out = withChat(withPlan(c, { ...np, status: ask ? "draft" : "running" }), "captain", `Revised the plan${ask ? " (waiting for your Start)" : ""}: ${words}`, now(), { kind: "plan", plan: pl.id });
      return logged(out, { at: now(), kind: "said", text: `Revised the plan (revision ${rev}): ${p.tasks.length} step${p.tasks.length === 1 ? "" : "s"} left` });
    });
    if (!ask) await advance((await d.managers.get(m.id)) ?? cur, rq.pid);
    return true;
  };

  /**
   * A running task's agent whose tool detached: its tool started again on its lane and told to carry on, once per stretch (by its
   * lane's last event); couldn't, said once in the chat. Never failed for it.
   */
  const carryOn = async (m: Manager, plan: Plan, task: PlanTask, last?: number) => {
    if (!task.sid || !task.lane) return;
    const { sid, lane } = { sid: task.sid, lane: task.lane };
    const k = `${sid}:${lane}:${last ?? (await d.events(sid)).at(-1)?.seq ?? 0}`;
    if (revived.has(k)) return;
    revived.add(k);
    const name = nameOfAgent(m, task);
    if (await revive(`lane:${sid}:${lane}`, sid, lane)) return void (await d.tell(sid, lane, "[Captain] Friday restarted, and your coding tool with it. Carry on with your task from where you were. When you're finished, end with a line `Done: <one line>`."));
    const tool = (await d.state(sid).catch(() => null))?.engines[lane]?.tool;
    await changeTask(m.id, plan.id, task.id, (c, _p, t, a) => update(c, `Couldn't start ${name}'s ${tool ? (TOOL_LABEL[tool] ?? tool) : "coding tool"} again: ${reviveWhy.get(`lane:${sid}:${lane}`)?.why ?? "it didn't come back"}.`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "failed" }));
  };
  /** Lanes re-briefed after a restart, started again, and quiet stretches said, once each. */
  const rebriefed = new Set<string>();
  const revived = new Set<string>();
  const quietTold = new Set<string>();
  /**
   * The minute's look at its running plans, so nothing stale shows as live (a restart, a lost event): a task taken but never given
   * a lane goes back to the queue; one whose session is gone fails; a run's end it missed is read now; a lane that never started
   * its brief is told it again; a lane running with nothing new for QUIET_MS is said once; a plan held up is taken up again.
   */
  const recoverPlans = async (list: readonly Manager[]) => {
    const states = new Map<string, SessionState | null>();
    const evsOf = new Map<string, SessionEvent[]>();
    const stateOf = async (sid: string) => (states.has(sid) ? states.get(sid)! : (states.set(sid, await d.state(sid).catch(() => null)), states.get(sid)!));
    const eventsOf = async (sid: string) => evsOf.get(sid) ?? (evsOf.set(sid, await d.events(sid).catch(() => [])), evsOf.get(sid)!);
    for (const m of list)
      for (const plan of m.plans ?? []) {
        // A finished round whose judging turn was lost (Friday restarted mid-turn, or the Captain never answered): asked once more,
        // then it goes out unjudged, so an overnight goal always ends in its morning report. Only the newest round of its goal, from
        // the last 12 hours, and not a plan from before rounds (a report and no verdict: it was told then).
        if (plan.status === "done" && !plan.shipped && !(plan.report && !plan.verdict) && !proving.has(plan.id)) {
          const last = Math.max(plan.at, plan.final?.at ?? 0, ...plan.tasks.map((t) => t.ended ?? 0));
          const newest = !(m.plans ?? []).some((x) => x.goal === plan.goal && x.at > plan.at);
          const asked = rejudged.get(plan.id);
          if (newest && now() - last < 12 * 3_600_000 && now() - Math.max(last, asked ?? 0) > FINAL_STALE_MS) {
            const pending = reportAsks.get(m.id);
            // Its judging turn asked in this run and still out: its clock starts now, and it goes out unjudged if it stays quiet.
            if (!asked && pending?.pid === plan.id) rejudged.set(plan.id, now());
            else if (!asked && !pending && !plan.verdict && !whyNot(m)) {
              rejudged.set(plan.id, now());
              const told = reportText(m, plan, m.goals?.find((g) => g.id === plan.goal)?.title ?? "A plan", m.goals?.find((g) => g.id === plan.goal));
              reportAsks.set(m.id, { pid: plan.id, told });
              if (!(await wakeCaptain(m, told, false).catch(() => false))) reportAsks.delete(m.id);
            } else if (!pending || pending.pid === plan.id) {
              if (pending) reportAsks.delete(m.id);
              await shipGoal(m.id, plan.id).catch((e: Error) => say(`[plans] ship: ${e.message}`));
            }
          }
          continue;
        }
        if (plan.status !== "running") continue;
        // The check of the whole whose result was missed (Friday restarted mid-check, its lane's tool gone): read from its events
        // now; nothing there after FINAL_STALE_MS, finished without it. Arun, 2026-11-28: the edge Captain sat at "Checking the
        // whole" with every agent done, and the sidebar counted it as working.
        if (plan.final?.status === "checking" && m.sid) {
          const at = plan.final.at;
          const lane = m.lane ?? MAIN_LANE;
          const evs = await eventsOf(m.sid);
          const end = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended" && e.ts <= at);
          const cs = checkStateOf(evs, lane, end?.seq ?? 0);
          const proof = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.ts >= at && (e.body.type === "proof.tests" || e.body.type === "proof.status"));
          // Quiet for FINAL_STALE_MS (nothing on its lane, not just no result: a long test run still says how it's going): run once
          // more, then finish without it, said (the audit, 2026-11-28: it gave up on a check still running, and never re-ran one a
          // restart killed).
          const heard = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane)?.ts ?? 0;
          if (proof && cs.phase !== "checking") await finalRead(m, m.sid, lane, proof.seq + 1).catch((e: Error) => say(`[plans] final check: ${e.message}`));
          else if (now() - Math.max(at, heard) > FINAL_STALE_MS) {
            const again = !rechecked.has(plan.id) && d.check ? (rechecked.add(plan.id), await d.check(m.sid, lane).catch(() => false)) : false;
            if (again) await d.managers.update(m.id, (cur) => ((p) => (p?.final?.status === "checking" ? withPlan(cur, { ...p, final: { status: "checking", at: now() } }) : null))(planOf(cur, plan.id)));
            else {
              await d.managers.update(m.id, (cur) => ((p) => (p?.final?.status === "checking" ? update(withPlan(cur, { ...p, final: { status: "none", at: now(), why: "The check of the whole never reported back" } }), "The check of the whole never reported back, so I finished without it. Run your tests before you ship.", { tone: "info" }) : null))(planOf(cur, plan.id)));
              await finalize(m.id, plan.id);
            }
          }
          continue;
        }
        for (const task of plan.tasks) {
          if (task.status === "running" && !task.lane) {
            if (task.started && now() - task.started > RECOVER_MS)
              await changeTask(m.id, plan.id, task.id, (c, p, t) => logged(withPlan(c, withTask(p, t.id, { status: "queued", tries: Math.max(0, t.tries - 1) })), { at: now(), kind: "said", text: `"${clip(t.text, 80)}" never got going; it starts again` }));
            continue;
          }
          if ((task.status !== "running" && task.status !== "checking") || !task.sid || !task.lane) continue;
          const lane = task.lane;
          const st = await stateOf(task.sid);
          const name = nameOfAgent(m, task);
          if (!st || !(lane === MAIN_LANE || st.engines[lane] || st.lanes.some((l) => l.id === lane))) {
            await changeTask(m.id, plan.id, task.id, (c, p, t, a) => update(withAgent(withPlan(c, withTask(p, t.id, { status: "failed", ended: now(), result: "Its lane is gone" })), a?.id, { status: "failed" }), `${name}'s lane is gone, so "${t.text}" stopped`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "failed" }));
            await settle(m.id, plan.id);
            continue;
          }
          // A step's check whose result was missed, or that went quiet (a restart mid-check): read now; quiet past FINAL_STALE_MS, run
          // once more, then done without it, said (the audit, 2026-11-28: a step sat in "checking" for ever).
          if (task.status === "checking") {
            const evs = await eventsOf(task.sid);
            const end = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
            if (!end) continue;
            const cs = checkStateOf(evs, lane, end.seq);
            if (cs.phase !== "none" && cs.phase !== "checking") {
              await planCheck(m, plan, task, (evs.at(-1)?.seq ?? end.seq) + 1).catch((e: Error) => say(`[plans] step check: ${e.message}`));
              continue;
            }
            const heard = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane)?.ts ?? 0;
            if (now() - heard <= FINAL_STALE_MS) continue;
            const k = `${task.sid}:${lane}:${end.seq}`;
            const again = !rechecked.has(k) && d.check ? (rechecked.add(k), await d.check(task.sid, lane).catch(() => false)) : false;
            if (!again) await taskDone(m, plan.id, task.id, task.result ?? "Finished", " (its check never reported back)");
            continue;
          }
          const evs = await eventsOf(task.sid);
          const mine = evs.filter((e) => (e.lane ?? MAIN_LANE) === lane && e.ts >= (task.started ?? 0));
          // Its tool detached (Friday restarted, an update): an end it missed is read; otherwise its tool is started again on its
          // lane and told to carry on, never failed for it. Once per stretch; couldn't, said once.
          const eng = st.engines[lane];
          if (eng?.tool && !eng.online) {
            const end = mine.findLast((e) => e.body.type === "run.ended");
            if (end && !seenEnds.has(`${task.sid}:${lane}:${end.seq}`)) {
              await taskEvent(m, plan, task, end, st).catch((e: Error) => say(`[plans] recover: ${e.message}`));
              continue;
            }
            await carryOn(m, plan, task, evs.at(-1)?.seq ?? 0);
            continue;
          }
          if (statusAt(st, lane) === "running") {
            const last = mine.at(-1);
            const k = `${task.sid}:${lane}:${last?.seq ?? 0}`;
            if (last && now() - last.ts >= QUIET_MS && !quietTold.has(k)) {
              quietTold.add(k);
              await changeTask(m.id, plan.id, task.id, (c, _p, t, a) => update(c, `${name} has shown nothing new for ${Math.round((now() - last.ts) / 60_000)} minutes on "${t.text}". Look at its lane, or cancel the plan.`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "needs" }));
            }
            continue;
          }
          if (st.approvals?.[lane] || st.asks?.[lane]?.questions.length) continue;
          const end = mine.findLast((e) => e.body.type === "run.ended");
          if (end && !seenEnds.has(`${task.sid}:${lane}:${end.seq}`)) await taskEvent(m, plan, task, end, st).catch((e: Error) => say(`[plans] recover: ${e.message}`));
          else if (!end && !mine.some((e) => e.body.type === "run.started") && task.started && now() - task.started > RECOVER_MS && !rebriefed.has(`${task.sid}:${lane}`)) {
            rebriefed.add(`${task.sid}:${lane}`);
            const a = m.agents?.find((x) => x.id === task.agent) ?? { name, role: task.role, brief: "" };
            await tellLane(task.sid, lane, task.judge ? await judgeText(m, plan, task, a, m.goals?.find((g) => g.id === plan.goal)?.ask ?? "") : taskBrief(m, plan, task, a, m.goals?.find((g) => g.id === plan.goal)?.ask ?? "", !!task.copy, m.goals?.find((g) => g.id === plan.goal)));
          }
        }
        const fresh = (await d.managers.get(m.id)) ?? m;
        const p = planOf(fresh, plan.id);
        // Revising with no revision asked for (a restart lost the ask): not revising any more; held up, taken up again.
        if (p?.revising && replanAsks.get(m.id)?.pid !== p.id) await d.managers.update(m.id, (c) => ((x) => (x?.revising ? withPlan(c, (({ revising: _r, ...rest }) => rest)(x)) : null))(planOf(c, p.id)));
        if (p?.status === "running" && planState(withBlocked(p)) === "stuck" && !replanAsks.has(m.id)) await stuck(m.id, p.id);
        // Every step done but the plan still running (Friday stopped between a step's end and what comes after): carried on now. Not
        // after a failed check of the whole, which waits on a revision or the person.
        else if (p?.status === "running" && !p.final && !p.revising && planState(p) === "done") await settle(m.id, p.id);
      }
  };

  /**
   * A task as its card shows it opened (Arun's plan-card mock, 2026-11-27): its short title, the files its lane changed (project
   * paths) with the lines in and out, how many tool calls it made, and what it's asking the person, with any choices, while it
   * waits on them. Read from its lane's log; nothing stored.
   */
  const taskView = async (m: Manager, p: Plan, t: PlanTask, read: (sid: string) => Promise<{ st: SessionState | null; evs: SessionEvent[] }>): Promise<PlanTask & { files?: string[]; added?: number; removed?: number; tools?: number; ask?: { at: number; text: string; options?: string[] } }> => {
    const title = t.title ?? taskTitle(t.text);
    const base = { ...t, ...(title ? { title } : {}) };
    if (!t.sid || !t.lane) return base;
    const { st, evs } = await read(t.sid);
    const lane = t.lane;
    const mine = evs.filter((e) => (e.lane ?? MAIN_LANE) === lane && e.ts >= (t.started ?? 0));
    const copy = st?.engines[lane]?.copyOf ? st.engines[lane]!.cwd : undefined;
    const { edits } = editsOf(mine, [m.project.folder, ...(copy ? [copy] : [])], lane);
    const files = [...new Set(edits.map((e) => e.file))];
    const tools = mine.reduce((n, e) => n + (e.body.type === "agent.message" ? e.body.toolCalls.length : 0), 0);
    // Its open question to the person, on its lane, with the choices it offered (its ask card's, or the ones its words listed).
    const q = t.status === "running" ? m.log.find((a) => a.kind === "for-you" && a.lane === lane && a.sid === t.sid && !a.answered && !a.dismissed) : undefined;
    const card = q ? mine.findLast((e) => e.body.type === "agent.question") : undefined;
    const options = card?.body.type === "agent.question" ? card.body.options : st?.asks?.[lane]?.questions[0]?.options?.map((o) => o.label ?? "").filter(Boolean);
    return {
      ...base,
      ...(files.length ? { files, added: edits.reduce((n, e) => n + e.added, 0), removed: edits.reduce((n, e) => n + e.removed, 0) } : {}),
      ...(tools ? { tools } : {}),
      ...(q ? { ask: { at: q.at, text: q.text, ...(options?.length ? { options } : {}) } } : {}),
    };
  };
  /** Each Captain's own lane's work, kept until its session's last event changes. */
  const workKept = new Map<string, { k: string; w: CaptainWork }>();
  /** Each session's state and events for the page, kept a few seconds (it asks every 5 s). */
  const liveKept = new Map<string, { at: number; st: SessionState | null; evs: SessionEvent[] }>();
  /**
   * Its agents as they really are, for the page (Arun, 2026-11-27: "everything on the captain page is dynamic and accurate"): each
   * one's status from its lane's run now, not as last written (a Coder showed Running 43 minutes on a lane long quiet), when that
   * began, its latest step, and what its lane spent (spend.ts prices). With the Captain's line from the same facts and each plan's
   * counts.
   */
  const liveOf = async (list: readonly Manager[]) => {
    const out = new Map<string, { agents: (CaptainAgent & AgentLive)[]; now: ReturnType<typeof captainNow> & { modelLabel?: string }; plans: (Plan & { progress: ReturnType<typeof planProgress>; tasks: Awaited<ReturnType<typeof taskView>>[] })[]; captain?: CaptainWork }>();
    const read = async (sid: string) => {
      const k = liveKept.get(sid);
      if (k && now() - k.at < 3000) return k;
      const st = await d.state(sid).catch(() => null);
      const v = { at: now(), st, evs: st ? await d.events(sid).catch(() => [] as SessionEvent[]) : [] };
      liveKept.set(sid, v);
      return v;
    };
    for (const m of list) {
      const agents: (CaptainAgent & AgentLive)[] = [];
      for (const a0 of m.agents ?? []) {
        // Crew is this Captain's own agents: one from an earlier build (a thread of its own, or on a plan put away) isn't listed, and
        // a saved one of those shows with no lane (Arun's edge Captain, 2026-11-27: an old Coder "Running" 3h in the tree). Its thread
        // is left alone.
        const plan = (m.plans ?? []).find((p) => p.tasks.some((t) => t.agent === a0.id));
        const old = (!!a0.sid && (!m.sid || a0.sid !== m.sid || a0.lane === (m.lane ?? MAIN_LANE))) || (plan?.status === "cancelled" && plan.tasks.some((t) => t.agent === a0.id && /^Put away/.test(t.result ?? "")));
        if (old && !a0.saved) continue;
        const a: CaptainAgent = old ? (({ sid: _s, lane: _l, ...rest }) => ({ ...rest, status: "idle" as const }))(a0) : a0;
        if (!a.sid || !a.lane) {
          agents.push({ ...a, state: "idle", tokens: 0, usd: 0 });
          continue;
        }
        const { st, evs } = await read(a.sid);
        const lane = a.lane;
        const eng = st?.engines[lane];
        const run = st ? runAt(st, lane) : undefined;
        const mine = evs.filter((e) => (e.lane ?? MAIN_LANE) === lane);
        const end = mine.findLast((e) => e.body.type === "run.ended");
        const state: AgentLive["state"] = !st || (!eng && !st.lanes.some((l) => l.id === lane))
          ? "gone"
          : run?.status === "running"
            ? "running"
            : run?.status === "waiting_for_human" || st.approvals?.[lane] || st.asks?.[lane]?.questions.length
              ? "waiting"
              : run?.status === "error" || (end?.body.type === "run.ended" && end.body.outcome === "error")
                ? "errored"
                : eng && !eng.online
                  ? "stopped"
                  : "idle";
        const sp = mine.length ? spendOf([{ sid: a.sid, lanes: [lane], events: evs, engines: { [lane]: { ...(eng?.tool ? { tool: eng.tool } : {}), ...(eng?.model ? { model: eng.model } : {}) } } }], 0) : null;
        const lastWords = lastSaid(mine, lane).split("\n").map((x) => x.trim()).filter(Boolean).at(-1);
        const since = run?.sinceAt ?? mine.at(-1)?.ts;
        // Its work is in the project folder (brought together, or it never left it), or only in its copy.
        const onTask = (m.plans ?? []).flatMap((p) => p.tasks).find((t) => t.agent === a.id && t.lane === lane);
        const applied = !onTask?.copy || !!onTask.applied;
        agents.push({ ...a, applied, status: liveStatus(a, { state }), state, ...(since ? { since } : {}), ...(lastWords ? { activity: clip(lastWords.replace(/^done\s*:\s*/i, "Done: "), 200) } : {}), ...(mine.length ? { lastAt: mine.at(-1)!.ts } : {}), tokens: sp ? tokensTotal(sp.tokens) : 0, usd: sp ? Math.round(sp.usd * 10_000) / 10_000 : 0 });
      }
      // Its own lane's turn, worked out again only when its session has moved on (its last event), as the overview keeps its own.
      let captain: CaptainWork | undefined;
      if (m.sid) {
        const { st, evs } = await read(m.sid);
        const lane = m.lane ?? MAIN_LANE;
        const k = `${m.sid}:${lane}:${evs.at(-1)?.seq ?? 0}:${st ? statusAt(st, lane) : ""}`;
        const kept = workKept.get(m.id);
        captain = kept?.k === k ? kept.w : laneWork(evs, lane, st ? runAt(st, lane) : undefined);
        workKept.set(m.id, { k, w: captain });
        // A run said to be going on a lane with no tool attached isn't going (its end is only written after the hub's grace).
        if (captain.state === "running" && st?.engines[lane] && !st.engines[lane]!.online) captain = { ...captain, state: "idle" };
        // Its message never started a run (startGuard): errored, with why, until one does (a run starting clears the stall).
        if (m.stall) captain = { ...captain, state: "errored", reason: m.stall.why };
      }
      // An earlier build's plans showing as live: put away now, not at the next minute.
      if (m.autonomy && m.sid && (m.plans ?? []).some((p) => (p.status === "running" || p.status === "draft") && p.tasks.some((t) => !!t.sid && (t.sid !== m.sid || t.lane === (m.lane ?? MAIN_LANE))))) void putAway(m.id).catch(() => {});
      const cn = captainNow(m, agents, now());
      const label = modelWords(cn.model);
      const pick = ENGINE_MODEL_INFO[m.tool]?.find((x) => x.id !== "auto" && (x.id === cn.model || x.label === label));
      out.set(m.id, { agents, now: { ...cn, model: pick?.id ?? cn.model, ...(label ? { modelLabel: label } : {}) }, plans: await Promise.all((m.plans ?? []).map(async (p) => ({ ...p, progress: planProgress(p), tasks: await Promise.all(p.tasks.map((t) => taskView(m, p, t, read))) }))), ...(captain ? { captain } : {}) });
    }
    return out;
  };

  /** Task runs nudged to finish properly, once each: `${sid}:${lane}:${runSeq}`. */
  const nudged = new Set<string>();
  /** Agents' run ends already read: `${sid}:${lane}:${seq}`. */
  const seenEnds = new Set<string>();
  /**
   * Something in one of its agents' threads: a turn ending (done with its Done: line, or asking, or on an error), a question or a
   * go-ahead (the person's, never its own), or the agent going again after one.
   */
  const taskEvent = async (m: Manager, plan: Plan, task: PlanTask, ev: SessionEvent, st: SessionState | null) => {
    const lane = ev.lane ?? MAIN_LANE;
    if (plan.status !== "running" || (task.lane && lane !== task.lane)) return;
    const b = ev.body;
    // Its check failed and it was sent back to fix it: the fix's end is checked again.
    if (task.status === "checking") {
      if (b.type === "run.ended" && b.outcome === "done" && d.check && !checkedRuns.has(`${task.sid}:${lane}:${ev.seq}`)) {
        checkedRuns.add(`${task.sid}:${lane}:${ev.seq}`);
        await d.check(task.sid!, lane).catch((e: Error) => say(`[plans] check: ${e.message}`));
      }
      return;
    }
    if (task.status !== "running") return;
    // Each run's end read once (the minute's look reads ends it may have missed).
    if (b.type === "run.ended") {
      const k = `${task.sid}:${lane}:${ev.seq}`;
      if (seenEnds.has(k)) return;
      seenEnds.add(k);
    }
    const needs = (what: string) =>
      changeTask(m.id, plan.id, task.id, (cur, _p, _t, a) => (a?.status === "needs" ? null : update(withAgent(cur, a?.id, { status: "needs" }), `${a?.name ?? "An agent"} needs you: ${what}`, { ...(a ? { agent: a.id } : {}), task: task.id, tone: "needs" })));
    if (b.type === "run.started") {
      await changeTask(m.id, plan.id, task.id, (cur, _p, _t, a) => (a?.status === "needs" ? withAgent(cur, a.id, { status: "working" }) : null));
      return;
    }
    if (b.type === "agent.question") return void (await askCaptain(m, plan, task, b.question + (b.options?.length ? ` (options: ${b.options.join(" / ")})` : "")));
    if (b.type === "engine.approval" || (b.type === "run.ended" && b.outcome === "waiting")) return void (await needs(st?.approvals?.[lane]?.items[0] ? `a go-ahead to run \`${st.approvals[lane]!.items[0]}\`` : "a go-ahead"));
    if (b.type !== "run.ended") return;
    if (b.outcome === "error") {
      if (b.cut) return;
      if (d.limitHit(b.error ?? "")) return void (await needs("its coding tool hit its usage limit"));
      const err = clip(b.error ?? "", 600);
      if (task.tries < TASK_TRIES) {
        // Once more, with the error: no Captain turn spent.
        await changeTask(m.id, plan.id, task.id, (cur, p, t, a) => update(withPlan(cur, withTask(p, t.id, { tries: t.tries + 1 })), `${a?.name ?? "An agent"} hit an error, trying again${err ? `: ${err}` : ""}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "info" }));
        setTimeoutFn(() => void tellLane(task.sid!, lane, `[Captain] Your last turn stopped on an error${err ? ` (${err})` : ""}. Try again, carrying on where you were. When you're finished, end with a line \`Done: <one line>\`.`).catch(() => false), d.retryMs ?? RETRY_MS);
        return;
      }
      await changeTask(m.id, plan.id, task.id, (cur, p, t, a) =>
        update(withAgent(withPlan(cur, withTask(p, t.id, { status: "failed", ended: now(), result: err || "It stopped on an error" })), a?.id, { status: "failed" }), `${a?.name ?? "An agent"} failed: ${t.text}${err ? ` (${err})` : ""}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "failed" }),
      );
      await settle(m.id, plan.id);
      return;
    }
    // Ended asking in plain text (how coding tools ask, "should I…?"): the Captain's to answer, or the person's.
    const qs = st?.asks?.[lane]?.questions ?? [];
    if (qs.length) return void (await askCaptain(m, plan, task, qs.slice(0, 4).map((x) => x.question).join(" ")));
    const evs = await d.events(task.sid!);
    const start = evs.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
    const text = evs.filter((e) => e.seq > start && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent").map((e) => (e.body as { text?: string }).text ?? "").at(-1) ?? "";
    const result = doneOf(text);
    // Stopped short with no Done: line (asking leave to go on, its plan unfinished): told once to carry on, no Captain turn.
    const k = `${task.sid}:${lane}:${start}`;
    if (!result && !nudged.has(k) && (offerOf(text) || unfinishedOf(st?.planDone?.[lane]))) {
      nudged.add(k);
      await tellLane(task.sid!, lane, "[Captain] Carry on with your task to the end; it's yours to finish. When you're finished, end with a line `Done: <one line>`.");
      return;
    }
    const line = result ?? (text.split("\n").map((x) => x.trim()).find(Boolean)?.slice(0, 200) || "Finished");
    // What it ran to prove it (its "Checked:" line), kept for its card and the Recap.
    const checked = checkedOf(text);
    if (checked) await changeTask(m.id, plan.id, task.id, (cur, p, t) => withPlan(cur, withTask(p, t.id, { checked })));
    // What it learned for the rest of the crew, in the goal's shared notebook (its "Note:" lines): every later brief has it.
    const notes = notesOf(text);
    if (notes.length) await d.managers.update(m.id, (cur) => withNotebook(cur, plan.goal, `${nameOfAgent(cur, task)} (${task.role})`, notes, now()));
    // A judge of two attempts: its pick (or A, when it named none) made, and the step goes on with that one. Its copy holds only
    // what it tried, so it's never checked or brought in.
    if (task.judge) {
      const pick = pickOf(text);
      const why = result ?? "";
      let lose: PlanTask | undefined;
      await changeTask(m.id, plan.id, task.id, (cur, p, t) => {
        const picked = pickTwin(p, t.id, pick ?? 0, why);
        const win = picked.tasks.find((x) => x.id === t.judge![pick ?? 0]);
        lose = picked.tasks.find((x) => x.id === t.judge![1 - (pick ?? 0)]);
        // Who won on which tool, remembered: the next crew leans toward the tool that wins these (winEdge in pickCrewTool).
        const toolOf = (x?: PlanTask) => (x?.agent ? cur.agents?.find((a) => a.id === x.agent)?.tool : undefined);
        const [wt, lt] = [toolOf(win), toolOf(lose)];
        const learned = wt && lt ? withWin(cur, wt, lt) : cur;
        return logged(withPlan(learned, picked), { at: now(), kind: "said", text: `Picked ${win?.title ?? "an attempt"}${pick === null ? " (the judge named none, so the first)" : ""}: ${clip(why, 160)}` });
      });
      await taskDone((await d.managers.get(m.id)) ?? m, plan.id, task.id, line, "");
      // The attempt not picked and the judge's own copy are never brought in: cleared now with their branches, not left for later.
      if (d.retire)
        for (const x of [lose, task]) {
          if (!x?.sid || !x.lane) continue;
          await d.managers.update(m.id, (cur) => clearReady(cur, x.sid!, x.lane));
          const st2 = await d.state(x.sid).catch(() => null);
          const e = st2?.engines[x.lane];
          await d.retire(x.sid, x.lane, e?.copyOf ? (e.cwd ?? null) : null).catch((err: Error) => say(`[plans] clear copy: ${err.message}`));
        }
      return;
    }
    // Changes, with checks on: Friday's Check it on its lane first (planCheck), and only a pass makes it done, so nothing builds on
    // work that fails its tests. Nothing to check: done now.
    if (m.checkWork !== false && d.check && st?.diffs?.[lane]?.files.length) {
      await changeTask(m.id, plan.id, task.id, (cur, p, t) => withPlan(cur, withTask(p, t.id, { status: "checking", result: line })));
      checkedRuns.add(`${task.sid}:${lane}:${ev.seq}`);
      await d.check(task.sid!, lane).catch((e: Error) => say(`[plans] check: ${e.message}`));
      return;
    }
    await taskDone(m, plan.id, task.id, line, "");
  };

  /** A task's work done (checked, or with nothing to check): its ready card, its agent back to the roster or retired, the next started. */
  const taskDone = async (m: Manager, pid: string, tid: string, line: string, how: string) => {
    const t0 = planOf(m, pid)?.tasks.find((t) => t.id === tid);
    const item = t0?.sid && t0.lane && d.readyOf ? await d.readyOf(t0.sid, t0.lane).catch(() => null) : null;
    await changeTask(m.id, pid, tid, (cur, p, t, a) => {
      const next = withAgent(withPlan(cur, withTask(p, t.id, { status: "done", ended: now(), result: line })), a?.id, { status: a?.saved ? "idle" : "done" });
      return update(item ? withReady(next, { ...item, at: now() }) : next, `${a?.name ?? "An agent"} done: ${line}${how}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "done" });
    });
    await settle(m.id, pid);
  };

  /**
   * A check's result on a plan task's lane (Friday's Check it, whoever ran it). Passed or nothing to run: the task is done. Failed:
   * sent back to its agent once with what failed (as checkWork does); failing again, the task fails and it's the person's.
   */
  const planCheck = async (m: Manager, plan: Plan, task: PlanTask, at: number) => {
    if (task.status !== "checking" || !task.sid || !task.lane) return;
    const { sid, lane } = { sid: task.sid, lane: task.lane };
    const evs = await d.events(sid);
    const end = evs.findLast((e) => e.seq < at && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
    if (!end) return;
    const cs = checkStateOf(evs, lane, end.seq);
    if (cs.phase === "none" || cs.phase === "checking") return;
    const k = `${sid}:${lane}:${end.seq}:read`;
    if (checkedRuns.has(k)) return;
    checkedRuns.add(k);
    const key = `${sid}:${lane}`;
    if (cs.phase !== "failed") {
      await d.managers.update(m.id, (cur) => withMisses(cur, key, 0));
      await taskDone(m, plan.id, task.id, task.result ?? "Finished", cs.phase === "passed" ? " (its check passes)" : "");
      return;
    }
    const misses = (m.misses?.[key] ?? 0) + 1;
    const why = cs.first ? `: ${cs.first}` : "";
    if (misses === 1) {
      await tellLane(sid, lane, fixFirstText(cs));
      await changeTask(m.id, plan.id, task.id, (cur, _p, t, a) => update(withMisses(cur, key, 1), `${a?.name ?? "An agent"}'s check failed${why}; sent back to fix it`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "info" }));
      return;
    }
    await changeTask(m.id, plan.id, task.id, (cur, p, t, a) =>
      update(withAgent(withMisses(withPlan(cur, withTask(p, t.id, { status: "failed", ended: now(), result: `Its check still fails${why}` })), key, misses), a?.id, { status: "failed" }), `${a?.name ?? "An agent"}'s check still fails after a fix${why}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "failed" }),
    );
    await settle(m.id, plan.id);
  };

  /**
   * After a task ended: more to start (or copies to bring together first), it goes on; held up by a failure with nothing left to
   * run, the Captain revises what's left (or it's the person's); everything done, the whole is checked and the plan finished.
   */
  const settle = async (id: string, pid: string) => {
    const m = await d.managers.get(id);
    const p0 = m && planOf(m, pid);
    if (!m || !p0 || p0.status !== "running") return;
    const plan = withBlocked(p0);
    if (plan !== p0) await d.managers.update(id, (cur) => ((p) => (p ? withPlan(cur, withBlocked(p)) : null))(planOf(cur, pid)));
    const state = planState(plan);
    if (state === "stuck") return void (await stuck(id, pid));
    if (state === "going" || toBring(plan).length) return void (await advance(m, pid));
    await finish(id, pid);
  };

  /** Plans already said to be held up, per revision: `${pid}:${revision}`. */
  const heldTold = new Set<string>();
  /**
   * Held up: the Captain gets a turn to revise what's left (REVISIONS_MAX at most, within its budget; the page says it's revising);
   * otherwise it's the person's, as one ask. The failed step's own line is already in the chat, so nothing more is posted there
   * (Arun's audit, 2026-11-27: one failure was four lines). `why` for a failure that isn't a step's (the check of the whole).
   */
  const stuck = async (id: string, pid: string, why?: string) => {
    const m = await d.managers.get(id);
    const plan = m && planOf(m, pid);
    if (!m || !plan || plan.status !== "running" || replanAsks.get(id)?.pid === pid) return;
    const rev = plan.revision ?? 0;
    const k = `${pid}:${rev}`;
    if (heldTold.has(k)) return;
    heldTold.add(k);
    const failed = plan.tasks.find((t) => t.status === "failed");
    const said = why ?? (failed ? `${nameOfAgent(m, failed)}'s step failed: ${failed.result ?? "it stopped"}` : "A step failed");
    const title = m.goals?.find((g) => g.id === plan.goal)?.title ?? "the plan";
    const busy = replanAsks.has(id) ? "I'm revising another plan" : "";
    const cant = rev >= REVISIONS_MAX ? `I've revised it ${rev} time${rev === 1 ? "" : "s"} already` : busy || ((w) => (w ? `${w}` : ""))(whyNot(m));
    if (!cant) {
      const told = replanText(m, plan, said, title);
      replanAsks.set(id, { pid, why: said, told });
      await d.managers.update(id, (cur) => ((p) => (p ? withPlan(cur, { ...p, revising: now() }) : null))(planOf(cur, pid)));
      if (await wakeCaptain(m, told, true).catch(() => false)) return;
      replanAsks.delete(id);
      await d.managers.update(id, (cur) => ((p) => (p?.revising ? withPlan(cur, (({ revising: _r, ...rest }) => rest)(p)) : null))(planOf(cur, pid)));
    }
    await askHeld(id, plan, said, cant);
  };
  /** A held-up plan brought to the person as one ask, about the failed step's lane: what failed, what it holds up, what to do. */
  const askHeld = async (id: string, plan: Plan, said: string, extra: string) => {
    const failed = plan.tasks.find((t) => t.status === "failed");
    const waiting = plan.tasks.filter((t) => t.status === "blocked").length;
    const text = `${said.replace(/[.\s]+$/, "")}.${waiting ? ` ${waiting === 1 ? "One step waits" : `${waiting} steps wait`} on it.` : ""}${extra ? ` ${extra.replace(/^./, (c) => c.toUpperCase()).replace(/[.\s]+$/, "")}.` : ""} What should I do? Look at its lane, or cancel the plan.`;
    const at = now();
    const next = await d.managers.update(id, (cur) => logged(cur, { at, kind: "for-you", text, ...(failed?.sid ? { sid: failed.sid } : {}), ...(failed?.lane ? { lane: failed.lane } : {}), plan: plan.id, keep: true }));
    const sid = failed?.sid ?? plan.tasks.find((t) => t.sid)?.sid;
    if (next && sid) d.notify?.(next, { kind: "ask", at, text, sid });
  };

  /**
   * Everything done: when copies were brought together, the whole is checked once on the Captain's own lane (the project folder);
   * then the plan is finished. Nothing to check there: finished now.
   */
  const finish = async (id: string, pid: string) => {
    const m = await d.managers.get(id);
    const plan = m && planOf(m, pid);
    if (!m || !plan || plan.status !== "running" || plan.final?.status === "checking") return;
    if (!plan.final && m.checkWork !== false && d.check && m.sid && m.lane && plan.tasks.some((t) => t.applied)) {
      const at = now();
      await d.managers.update(id, (cur) => ((p) => (p ? withPlan(cur, { ...p, final: { status: "checking", at } }) : null))(planOf(cur, pid)));
      if (await d.check(m.sid, m.lane).catch(() => false)) {
        await d.managers.update(id, (cur) => update(cur, `All ${plan.tasks.length} done; checking the whole together.`, { tone: "info" }));
        return;
      }
      await d.managers.update(id, (cur) => ((p) => (p ? withPlan(cur, { ...p, final: { status: "none", at } }) : null))(planOf(cur, pid)));
    }
    await finalize(id, pid);
  };

  /** The final check's result on the Captain's own lane: passed (or nothing to run) finishes it; failed, held up like a task. */
  const finalRead = async (m: Manager, sid: string, lane: string, at: number) => {
    const plan = m.plans?.find((p) => p.status === "running" && p.final?.status === "checking");
    if (!plan) return;
    const evs = await d.events(sid);
    const end = evs.findLast((e) => e.seq < at && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.ended");
    const cs = checkStateOf(evs, lane, end?.seq ?? 0);
    if (cs.phase === "checking") return;
    const failed = cs.phase === "failed";
    const why = failed ? `The check of the whole failed${cs.first ? `: ${cs.first}` : ""}` : undefined;
    await d.managers.update(m.id, (cur) => ((p) => (p ? withPlan(cur, { ...p, final: { status: failed ? "failed" : cs.phase === "passed" ? "passed" : "none", at: now(), ...(why ? { why } : {}) } }) : null))(planOf(cur, plan.id)));
    if (failed) return void (await stuck(m.id, plan.id, why!));
    await finalize(m.id, plan.id);
  };

  /** The plan finished: what each did in the chat now, on the phone, and the Captain's summary for the person in a turn of its own. */
  const finalize = async (id: string, pid: string) => {
    let done: Plan | null = null;
    const next = await d.managers.update(id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan || plan.status !== "running") return null;
      const n = plan.tasks.length;
      done = { ...plan, status: "done" };
      const what = plan.tasks.map((t) => `- ${nameOfAgent(cur, t)}: ${t.result ?? t.text}`).join("\n");
      const checked = plan.final?.status === "passed" ? " The check of the whole passes." : "";
      return logged(update(putAwayAsks(withPlan(cur, done), pid, null), `All ${n} done, ready for you.${checked}\n${what}`, { tone: "done" }), { at: now(), kind: "said", text: `Plan done: ${n} task${n === 1 ? "" : "s"}` });
    });
    if (!next || !done) return;
    const plan = done as Plan;
    const title = next.goals?.find((g) => g.id === plan.goal)?.title ?? "A plan";
    const sid = plan.tasks.find((t) => t.sid)?.sid;
    if (sid) d.notify?.(next, { kind: "report", text: `${title}: all ${plan.tasks.length} done, ready for you`, sid });
    // Its UI work proved with a clip, for the Recap (when proof clips are on): once a plan, only when work was brought into the folder.
    if (d.prove && next.sid && plan.tasks.some((t) => t.applied)) void d.prove(next.sid, next.lane ?? MAIN_LANE, pid, { summary: title }).catch((e: Error) => say(`[plans] proof clip: ${e.message}`));
    if (reportAsks.has(id)) return;
    // No turn to judge it (out of budget, quiet hours): it goes out as the settings say, unjudged.
    if (whyNot(next)) return void (await shipGoal(id, pid).catch((e: Error) => say(`[plans] ship: ${e.message}`)));
    const told = reportText(next, plan, title, next.goals?.find((g) => g.id === plan.goal));
    reportAsks.set(id, { pid, told });
    if (!(await wakeCaptain(next, told, false).catch(() => false))) reportAsks.delete(id);
  };

  /** A plan given up: its agents' lanes stopped (their work kept in their threads), what hadn't finished blocked, the plan cancelled. */
  const cancelPlan = async (m: Manager, pid: string, o: { apply?: boolean; discard?: boolean } = {}): Promise<{ ok: false } | { ok: true; unapplied: { id: string; title: string; agent: string }[] }> => {
    // Finished steps whose work is still only in their copies: brought in first when the person chose that (Stop, "bring finished
    // steps in"); else kept in their copies and said, never thrown away without their choice (the UX review, 2026-11-27).
    const before = planOf((await d.managers.get(m.id)) ?? m, pid);
    if (!before || (before.status !== "draft" && before.status !== "running")) return { ok: false };
    const finished = before.tasks.filter((t) => t.status === "done" && t.copy && !t.applied && !t.skipped);
    if (o.apply && finished.length) await bringTogether(m.id, pid, finished, true);
    let lanes: [string, string][] = [];
    let unapplied: { id: string; title: string; agent: string }[] = [];
    let copies: { sid: string; lane: string; applied: boolean }[] = [];
    const next = await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan || (plan.status !== "draft" && plan.status !== "running")) return null;
      const live = plan.tasks.filter((t) => t.status === "running" || t.status === "checking");
      lanes = live.flatMap((t) => (t.sid && t.lane ? [[t.sid, t.lane] as [string, string]] : []));
      unapplied = plan.tasks.filter((t) => t.status === "done" && t.copy && !t.applied && !t.skipped).map((t) => ({ id: t.id, title: t.title ?? t.text, agent: nameOfAgent(cur, t) }));
      copies = plan.tasks.filter((t) => t.copy && t.sid && t.lane).map((t) => ({ sid: t.sid!, lane: t.lane!, applied: !!t.applied }));
      const tasks = plan.tasks.map((t) => (t.status === "queued" || t.status === "running" || t.status === "checking" ? { ...t, status: "blocked" as const, ended: now(), result: "Cancelled" } : t));
      const ids = new Set(live.map((t) => t.agent).filter(Boolean));
      const agents = cur.agents?.map((a) => (ids.has(a.id) ? { ...a, status: "idle" as const } : a));
      const stopped = lanes.length ? `, stopped ${lanes.length === 1 ? "its agent" : `its ${lanes.length} agents`}` : "";
      const kept = unapplied.length && !o.discard ? `. ${unapplied.length === 1 ? "One finished step's work is" : `${unapplied.length} finished steps' work is`} still in ${unapplied.length === 1 ? "its copy" : "their copies"}, not in your folder: ${unapplied.map((u) => u.agent).join(", ")}` : unapplied.length ? `; ${unapplied.length} finished step${unapplied.length === 1 ? "'s" : "s'"} work thrown away, as you chose` : "";
      return logged(update(putAwayAsks(withPlan({ ...cur, ...(agents ? { agents } : {}) }, { ...plan, status: "cancelled", tasks }), pid, null), `Plan cancelled${stopped}${kept}`, { tone: "info" }), { at: now(), kind: "said", text: `Plan cancelled${stopped}` });
    });
    if (!next) return { ok: false };
    const me = await d.me();
    for (const [sid, lane] of lanes) await d.stop(sid, me, lane).catch(() => {});
    // Copies whose work is in the folder, or that the person chose to throw away, cleared with their branches; the rest kept.
    if (d.retire)
      for (const c of copies.filter((x) => x.applied || o.discard)) {
        const st = await d.state(c.sid).catch(() => null);
        const e = st?.engines[c.lane];
        await d.retire(c.sid, c.lane, e?.copyOf ? (e.cwd ?? null) : null).catch((err: Error) => say(`[plans] clear copy: ${err.message}`));
      }
    return { ok: true, unapplied: o.discard ? [] : unapplied };
  };

  /** The person looked over a finished plan's work: no longer "Ready for you"; its lanes' ready cards put away. */
  const seenPlan = async (m: Manager, pid: string): Promise<boolean> =>
    !!(await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      if (!plan) return null;
      const lanes = new Set(plan.tasks.flatMap((t) => (t.sid && t.lane ? [`${t.sid}:${t.lane}`] : [])));
      return withPlan({ ...cur, ready: (cur.ready ?? []).filter((r) => !lanes.has(`${r.sid}:${r.lane}`)) }, { ...plan, seen: now() });
    }));

  /**
   * The person runs a failed task again (or one held up by a failure), on a fresh agent and lane with its last error in the brief, or
   * skips it: what waits on it is queued again, its "For you" about the failure is put away, and the plan carries on. Why not,
   * otherwise.
   */
  const redoTask = async (m: Manager, pid: string, tid: string, how: "retry" | "skip"): Promise<{ ok: true } | { ok: false; error: string }> => {
    let why = "";
    let lane: string | undefined;
    const next = await d.managers.update(m.id, (cur) => {
      const plan = planOf(cur, pid);
      const t = plan?.tasks.find((x) => x.id === tid);
      if (!plan || !t) return (why = "That step isn't there any more."), null;
      lane = t.lane;
      const np = how === "retry" ? retryTask(plan, tid, now()) : skipTask(plan, tid, now());
      if (!np) return (why = how === "retry" ? "Only a failed step, or one held up by a failure, can run again." : "That step is done or running."), null;
      // The asks about it (its failure, a held-up plan) are answered by this.
      let out = withPlan(cur, np);
      for (const a of out.log) if (a.kind === "for-you" && !a.answered && !a.dismissed && (a.lane === t.lane || /What should I do\?/.test(a.text))) out = settleForYou(out, a.at, how === "retry" ? "Run it again" : "Skip it") ?? out;
      const name = nameOfAgent(cur, t);
      return logged(update(out, how === "retry" ? `Running "${t.title ?? t.text}" again${t.result ? `, with what went wrong last time` : ""}.` : `Skipped "${t.title ?? t.text}" (${name}'s step); carrying on without it.`, { task: tid, tone: "info" }), { at: now(), kind: "said", text: how === "retry" ? `Ran a step again: ${clip(t.text, 80)}` : `Skipped a step: ${clip(t.text, 80)}` });
    });
    if (!next) return { ok: false, error: why || "Couldn't change it." };
    heldTold.forEach((k) => k.startsWith(`${pid}:`) && heldTold.delete(k));
    // A revision asked of the Captain for it is no longer wanted: the person decided.
    if (replanAsks.get(m.id)?.pid === pid) replanAsks.delete(m.id);
    // Its old lane's tool stopped (its work there kept): a retry is a fresh agent.
    const old = planOf(m, pid)?.tasks.find((x) => x.id === tid);
    if (how === "retry" && old?.sid && lane) await d.stop(old.sid, await d.me(), lane).catch(() => {});
    await settle(m.id, pid);
    return { ok: true };
  };

  /** One of its agents into the project's roster, reused by role next time. */
  const keepAgent = async (m: Manager, aid: string): Promise<boolean> =>
    !!(await d.managers.update(m.id, (cur) => {
      const saved = saveAgent(cur, aid);
      const a = cur.agents?.find((x) => x.id === aid);
      return saved && a ? logged(saved, { at: now(), kind: "said", text: `Saved ${a.name} (${a.role}) to the roster` }) : null;
    }));

  // ── Missions (missions.ts): a Run Captain's goal owned for days ──────────────────────────────────────────────────────────────
  /** A plan or judgement asked of a Captain, by its id: its next reply is read for it (heardReply). */
  const missionAsk = new Map<string, { goal: string; kind: "plan" | "judge" }>();
  /** Mission threads already asked to open a pull request. */
  const prAsked = new Set<string>();
  /** The Captain asked to plan a mission, or to judge whether it's done. */
  const askMission = async (m: Manager, goalId: string, kind: "plan" | "judge"): Promise<boolean> => {
    const marked = await d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === goalId);
      if (!g?.mission || g.status === "cancelled" || g.status === "done") return null;
      return { ...cur, goals: cur.goals!.map((x) => (x.id === goalId ? { ...x, mission: { ...x.mission!, asked: { kind, at: now() } } } : x)) };
    });
    const g = marked?.goals?.find((x) => x.id === goalId);
    if (!marked || !g) return false;
    const cur = await ensure(marked);
    missionAsk.set(m.id, { goal: goalId, kind });
    const ready = (cur.ready ?? []).filter((r) => g.threads.some((t) => t.sid === r.sid)).map((r) => `${r.title}: ${r.facts}`);
    return d.tell(cur.sid!, cur.lane!, kind === "plan" ? missionPlanText(cur.project.name, g) : missionCheckText(cur.project.name, g, ready));
  };
  /** A mission given to a Run Captain: kept as one of its goals, and planned by it. */
  const startMission = async (m: Manager, input: Record<string, unknown>): Promise<{ ok: true; goal: Goal } | { ok: false; error: string }> => {
    if (!m.on || m.level !== "run") return { ok: false, error: "A Captain runs missions on Run. Switch it to Run first." };
    const c = cleanMission(input);
    if (!c.ok) return c;
    const goal: Goal = { id: `g_${randomBytes(4).toString("hex")}`, title: c.title, ask: c.ask, at: now(), status: "working", threads: [], mission: c.mission };
    const next = await d.managers.update(m.id, (cur) => logged({ ...cur, goals: keepGoals([goal, ...(cur.goals ?? [])]) }, { at: now(), kind: "said", text: `Mission: ${goal.title}` }));
    if (!next) return { ok: false, error: "That Captain isn't there any more." };
    await askMission(next, goal.id, "plan");
    return { ok: true, goal };
  };
  /** The tasks of its missions that may start, started: each a thread of its own in its own copy of the project. */
  const runMissions = async (m: Manager): Promise<number> => {
    const me = await d.me();
    let n = 0;
    for (const task of missionStarts(m, inQuiet(m, now()))) {
      let took = false;
      await d.managers.update(m.id, (cur) => {
        if (!cur.queue.some((q) => q.id === task.id)) return null;
        took = true;
        return { ...cur, queue: cur.queue.filter((q) => q.id !== task.id) };
      });
      if (!took) continue;
      const pick = await choose(m, task.text, me);
      if (!pick?.tool) {
        await d.managers.update(m.id, (cur) => logged({ ...cur, queue: [task, ...cur.queue] }, { at: now(), kind: "skipped", text: "No coding tool is ready to start the mission's next task" }));
        break;
      }
      const g = m.goals?.find((x) => x.id === task.goal);
      const sid = await d.create(task.text.split("\n")[0]!.slice(0, 80), me);
      await d.instruct(sid, me, `${task.text}\n\n(Part of the mission "${g?.title ?? "a mission"}": done when ${g?.mission?.done ?? "it's finished"}. Work in this copy; don't merge anything.)`);
      await d.startTool(sid, me, { tool: pick.tool, cwd: m.project.folder, project: m.project.name, copy: true, ...(pick.model ? { model: pick.model } : {}) });
      await attachToGoal(m, task, sid);
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "started", text: `Mission "${(g?.title ?? "").slice(0, 60)}": started "${task.text.slice(0, 80)}" on ${TOOL_LABEL[pick.tool] ?? pick.tool}${pick.why ? `: ${pick.why}` : ""}`, sid }));
      n++;
    }
    return n;
  };
  /** Paused or carried on by the person. */
  const pauseMission = async (m: Manager, goalId: string, on: boolean): Promise<boolean> => {
    const next = await d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === goalId);
      if (!g?.mission || !missionLive(g) || !!g.mission.paused === on) return null;
      const ms = on ? { ...g.mission, paused: { why: "you paused it", at: now(), by: "you" as const } } : (({ paused: _p, ...rest }) => rest)(g.mission);
      return logged({ ...cur, goals: cur.goals!.map((x) => (x.id === goalId ? { ...x, mission: ms } : x)) }, { at: now(), kind: "said", text: `Mission ${on ? "paused" : "carried on"}: ${g.title}` });
    });
    if (next && !on) await runMissions(next).catch(() => 0);
    return !!next;
  };
  /** Stopped for good: its queued tasks go, and its running threads' tools are stopped (their work is kept in their copies). */
  const stopMission = async (m: Manager, goalId: string): Promise<boolean> => {
    let threads: string[] = [];
    const next = await d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === goalId);
      if (!g?.mission || g.status === "cancelled" || g.status === "done") return null;
      threads = g.threads.filter((t) => t.state === "running").map((t) => t.sid);
      return logged({ ...cur, queue: cur.queue.filter((q) => q.goal !== goalId), goals: cur.goals!.map((x) => (x.id === goalId ? { ...x, status: "cancelled" as const } : x)) }, { at: now(), kind: "said", text: `Mission stopped: ${g.title}` });
    });
    if (!next) return false;
    if (missionAsk.get(m.id)?.goal === goalId) missionAsk.delete(m.id);
    const me = await d.me();
    for (const sid of threads) {
      const st = await d.state(sid).catch(() => null);
      for (const lane of Object.keys(st?.engines ?? {})) await d.stop(sid, me, lane).catch(() => {});
    }
    return true;
  };
  /**
   * Each minute, its live missions looked after: what their threads spent counted (and a mission over its budget paused), today's
   * report written once, a plan or judgement lost to a restart asked again, and the tasks that may start started.
   */
  const missionLook = async (list: readonly Manager[]) => {
    const day = dayOf(now());
    const hour = new Date(now()).getHours();
    for (const m of list) {
      const live = (m.goals ?? []).filter((g) => missionLive(g));
      if (!live.length) continue;
      const spent = new Map<string, number>();
      if (d.spent) for (const g of live) spent.set(g.id, (await Promise.all(g.threads.map((t) => d.spent!(t.sid).catch(() => 0)))).reduce((a, b) => a + b, 0));
      const told: { goal: Goal; text: string }[] = [];
      const again: { id: string; kind: "plan" | "judge" }[] = [];
      const next = await d.managers.update(m.id, (cur) => {
        let changed = false;
        const goals = (cur.goals ?? []).map((g) => {
          if (!missionLive(g)) return g;
          let ms = g.mission!;
          const usd = spent.get(g.id);
          if (usd !== undefined && Math.abs(usd - ms.spent) >= 0.005) (ms = { ...ms, spent: Math.round(usd * 100) / 100 }), (changed = true);
          const hold = overBudget(ms, now());
          if (hold) {
            ms = { ...ms, paused: hold };
            changed = true;
            told.push({ goal: g, text: `Mission "${g.title}" paused: ${hold.why}. Raise its budget or carry it on.` });
          }
          let out: Goal = ms === g.mission ? g : { ...g, mission: ms };
          if (reportDue(out, day, hour)) {
            const rep = missionReport(cur, out, day, now());
            out = { ...out, mission: { ...out.mission!, reports: [rep, ...out.mission!.reports].slice(0, REPORTS_KEEP) } };
            changed = true;
            told.push({ goal: out, text: `${out.title}: ${rep.text}` });
          }
          const asked = out.mission!.asked;
          const waiting = out.status === "checking" || (out.status === "working" && !out.threads.length && !cur.queue.some((q) => q.goal === out.id));
          if (waiting && (!asked || now() - asked.at >= ASK_AGAIN_MS) && missionAsk.get(cur.id)?.goal !== out.id) again.push({ id: out.id, kind: out.status === "checking" ? "judge" : "plan" });
          return out;
        });
        return changed ? { ...cur, goals } : null;
      });
      const cur = next ?? m;
      for (const t of told) d.notify?.(cur, { kind: "report", text: t.text, sid: t.goal.threads.at(-1)?.sid ?? "" });
      for (const a of again.slice(0, 1)) await askMission(cur, a.id, a.kind).catch((e: Error) => say(`[missions] ask: ${e.message}`));
      await runMissions(cur).catch((e: Error) => say(`[missions] start: ${e.message}`));
    }
  };

  /**
   * The person's answer to one of its questions (or "put away" with none): kept on that question, and, answered, told to the
   * Manager to pass on to the thread it's about, even in quiet hours or past its budget: the person asked for it.
   */
  const answer = async (m: Manager, at: number, text: string | null): Promise<"told" | "dismissed" | "gone"> => {
    let q: { text: string; sid?: string; lane?: string } | null = null;
    const next = await d.managers.update(m.id, (cur) => {
      const was = cur.log.find((a) => a.kind === "for-you" && a.at === at);
      const settled = settleForYou(cur, at, text);
      if (!settled || !was) return null;
      q = { text: was.text, ...(was.sid ? { sid: was.sid } : {}), ...(was.lane ? { lane: was.lane } : {}) };
      return text ? logged(settled, { at: now(), kind: "said", text: `You answered: ${text.slice(0, 160)}` }) : settled;
    });
    if (!next || !q) return "gone";
    if (!text) return "dismissed";
    const question = q as { text: string; sid?: string; lane?: string };
    // A question from one of its agents (Captain v2): the answer goes straight to that agent's lane, no Captain turn.
    const pt = question.sid && question.lane ? planThread([next], question.sid, question.lane) : null;
    if (pt && pt.task.status === "running") {
      await tellLane(question.sid!, question.lane!, `[Captain] The person answered: ${text}`);
      await changeTask(m.id, pt.plan.id, pt.task.id, (c, _p, t, a) => update(withAgent(c, a?.id, { status: "working" }), `You answered ${nameOfAgent(c, t)}: ${text}`, { ...(a ? { agent: a.id } : {}), task: t.id, tone: "info" }));
      return "told";
    }
    const cur = await ensure(next);
    await d.tell(cur.sid!, cur.lane!, answerText(question.text, text, question.sid));
    return "told";
  };

  /** A ready card looked at, shipped or put away. */
  const doneReady = async (m: Manager, sid: string, lane?: string) => !!(await d.managers.update(m.id, (cur) => clearReady(cur, sid, lane)));

  /** A finished turn that stopped short: asking leave to go on, or with its plan unfinished. Nothing on Watch. */
  const turnEnd = async (m: Manager, sid: string, lane: string, st: SessionState | null): Promise<Wake | null> => {
    if (!m.on || m.level === "watch") return null;
    const evs = await d.events(sid);
    const start = evs.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
    const last = evs.findLast((e) => e.seq > start && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent");
    const offer = last ? offerOf((last.body as { text?: string }).text ?? "") : null;
    if (offer) return { kind: "offer", sid, lane, detail: offer, hard: false };
    const left = unfinishedOf(st?.planDone?.[lane]);
    return left ? { kind: "unfinished", sid, lane, detail: left, hard: false } : null;
  };

  /** Runs whose end was checked or whose check was read, once each: `${sid}:${lane}:${endSeq}` (and `…:read`). */
  const checkedRuns = new Set<string>();
  /** A finished turn with changes, on Run: Friday's Check it, run by itself. */
  const checkEnd = async (m: Manager, sid: string, lane: string, endSeq: number, st: SessionState | null) => {
    if (!checksWork(m) || !d.check || !st?.diffs?.[lane]?.files.length) return;
    const k = `${sid}:${lane}:${endSeq}`;
    if (checkedRuns.has(k)) return;
    checkedRuns.add(k);
    await d.check(sid, lane).catch((e: Error) => say(`[managers] check: ${e.message}`));
  };
  /**
   * A check's result on a thread's run (whoever asked for it): passed, or nothing to run, and the work is ready for the person; a
   * failure goes back to the thread with what failed, once; failing again, it's the person's (spec 14, scenario 15).
   */
  const checkRead = async (m: Manager, sid: string, lane: string, at: number, st: SessionState | null) => {
    if (!checksWork(m)) return;
    const evs = await d.events(sid);
    // A split's end (hub.ended, on the session's main lane) counts as the end of its work, as a run's does.
    const end = evs.findLast((e) => e.seq < at && (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.ended" || e.body.type === "hub.ended"));
    if (!end) return;
    const cs = checkStateOf(evs, lane, end.seq);
    if (cs.phase === "none" || cs.phase === "checking") return;
    const k = `${sid}:${lane}:${end.seq}:read`;
    if (checkedRuns.has(k)) return;
    checkedRuns.add(k);
    const title = st?.title || "a thread";
    const key = `${sid}:${lane}`;
    if (cs.phase === "failed") {
      const misses = (m.misses?.[key] ?? 0) + 1;
      if (misses === 1) {
        await d.tell(sid, lane, fixFirstText(cs));
        await d.managers.update(m.id, (cur) => logged(withMisses(clearReady(cur, sid, lane) ?? cur, key, 1), { at: now(), kind: "sent-back", text: `Sent "${title}" its failing check to fix${cs.first ? `: ${cs.first}` : ""}`, sid, lane }));
      } else {
        const at = now();
        const text = `"${title}" still fails its check after a fix${cs.first ? ` (${cs.first})` : ""}. Look at it, or tell it what to try.`;
        await d.managers.update(m.id, (cur) => logged(withMisses(cur, key, misses), { at, kind: "for-you", text, sid, lane }));
        d.notify?.(m, { kind: "ask", at, text, sid });
        await goalMoved(m, sid, "stuck");
      }
      return;
    }
    const item = d.readyOf ? await d.readyOf(sid, lane).catch(() => null) : null;
    await d.managers.update(m.id, (cur) => {
      let next = withMisses(item ? withReady(cur, { ...item, at: now() }) : cur, key, 0);
      // Its question about this thread's failing check is answered by the pass.
      for (const a of cur.log) if (a.kind === "for-you" && a.sid === sid && a.lane === lane && !a.answered && !a.dismissed && /still fails its check/.test(a.text)) next = settleForYou(next, a.at, null) ?? next;
      return logged(next, { at: now(), kind: "checked", text: cs.phase === "passed" ? `"${title}" is ready: its check passes` : `"${title}" is ready: there was no check to run`, sid, lane });
    });
    if (item) d.notify?.(m, { kind: "ready", item: { ...item, at: now() } });
    await goalMoved(m, sid, "ready");
  };

  /** Threads whose merge was tidied after, by sid. */
  const mergedTold = new Set<string>();
  /** Each stuck run's rung on the ladder, by `${sid}:${lane}`: which run (its run.started seq) and how far up. */
  const ladder = new Map<string, { run: number; rung: number }>();
  /**
   * A thread stuck again, the Help ladder (Arun, 2026-11-25; spec 14: "a hint, then… a stronger model, then you"): first a hint from
   * the Captain; still stuck in the same run, its tool started again on its strongest model, the conversation kept, told to carry on
   * with a fresh look (no Captain turn); still stuck, it's yours, with the thread's Pass on to hand it to another tool.
   */
  const stuckRung = async (m: Manager, sid: string, lane: string, st: SessionState, evs: readonly SessionEvent[], me: Me) => {
    const run = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started")?.seq ?? 0;
    const k = `${sid}:${lane}`;
    const had = ladder.get(k);
    let rung = had && had.run === run ? had.rung + 1 : 1;
    const e = st.engines[lane];
    const title = st.title || "a thread";
    const name = e?.tool ? (TOOL_LABEL[e.tool] ?? e.tool) : "Its agent";
    // Its tool's strongest model: the first it lists that isn't Friday's Auto.
    const top = e?.tool ? ENGINE_MODEL_INFO[e.tool]?.find((x) => x.id !== "auto")?.id : undefined;
    // Near that tool's usage limit, no stronger model: it would spend the rest faster. Straight to the person.
    const tight = rung === 2 && e?.tool && d.nearLimit ? await d.nearLimit(e.tool).catch(() => false) : false;
    if (rung === 2 && (!e?.tool || !top || e.model === top || tight)) rung = 3;
    ladder.set(k, { run, rung });
    if (rung === 1) return void (await wake(m, { kind: "stuck", sid, lane, detail: "", hard: false }));
    if (rung === 2) {
      await d.startTool(sid, me, { tool: e!.tool!, cwd: e!.cwd, model: top!, lane, project: m.project.name });
      await d.tell(sid, lane, `[Friday] You've made no progress for a while, even after a hint, so you're on a stronger model now. Carry on from where you were with a fresh look: re-read the last error or output, question what you assumed, and try a different approach if the last one isn't working.`);
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "stepped-up", text: `Put ${name} in "${title}" on ${ENGINE_MODEL_INFO[e!.tool!].find((x) => x.id === top)?.label ?? top}: still stuck after a hint`, sid, lane }));
      return;
    }
    if (rung === 3) {
      const text = `"${title}" is still stuck after a hint${had?.rung === 2 ? " and a stronger model" : tight ? ` (${name} is near its usage limit, so no stronger model)` : ""}. Look at it, tell it what to try, or hand it to another coding tool with Pass on.`;
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "for-you", text, sid, lane }));
      d.notify?.(m, { kind: "ask", at: now(), text, sid });
      await goalMoved(m, sid, "stuck");
    }
  };
  /** Threads asked to try again after an error, when: once per RETRY_WINDOW_MS each, by `${sid}:${lane}`. */
  const retried = new Map<string, number>();
  const setTimeoutFn = (fn: () => void, ms: number) => (ms <= 0 ? fn() : void (setTimeout(fn, ms) as { unref?: () => void }).unref?.());
  /** Splits whose parts are together and whose main agent is looking them over. */
  const reviewing = new Set<string>();
  /** A lane that is one of a split task's parts. */
  const isPart = (st: SessionState | null, lane: string) => !!st?.hub && Object.values(st.hub.runs).some((r) => r.lane === lane);
  /**
   * A split task's end. Brought together: checked (on Run with checks on) or straight to a ready card; nothing got through: why,
   * for you. Its parts' own misses are on its card in the thread.
   */
  const splitEnded = async (m: Manager, sid: string, body: { outcome: string; why?: string; tasks: number; done: number }, st: SessionState | null) => {
    const title = st?.title || "a big task";
    if (body.outcome === "cancelled") return;
    if (body.outcome !== "done" || !body.done) {
      const text = `Couldn't get "${title}" done in parts${body.why ? `: ${body.why}` : ""}. Look at it, or tell it what to try.`;
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "for-you", text, sid, lane: MAIN_LANE }));
      d.notify?.(m, { kind: "ask", at: now(), text, sid });
      await goalMoved(m, sid, "stuck");
      return;
    }
    await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `"${title}": ${body.done} of ${body.tasks} parts done and brought together`, sid, lane: MAIN_LANE }));
    // Its parts' lanes and copies, once their work is in the task's copy cleanly: a part that came back with conflicts, or didn't
    // get through, keeps its copy for you to look at.
    if (tidiesIdle(m) && d.retire && st?.hub) {
      const evs = await d.events(sid);
      let cleared = 0;
      for (const [task, run] of Object.entries(st.hub.runs)) {
        if (!run.lane || run.status !== "done") continue;
        const merged = evs.findLast((e) => e.body.type === "hub.merged" && e.body.id === st.hub!.id && e.body.task === task);
        if (!merged || merged.body.type !== "hub.merged" || merged.body.conflicts.length) continue;
        await d.retire(sid, run.lane, st.engines[run.lane]?.cwd ?? null).catch((e: Error) => say(`[managers] clear part: ${e.message}`));
        cleared++;
      }
      if (cleared) await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Cleared ${cleared === 1 ? "its part's copy" : `its ${cleared} parts' copies`}: their work is in "${title}"`, sid, lane: MAIN_LANE }));
    }
    // One look over the whole, by the agent in the task's own copy: the parts fit, the checks run, nothing committed. Its turn's
    // end is then checked (or made ready) as any thread's is.
    reviewing.add(sid);
    await d.tell(sid, MAIN_LANE, splitReview(title, body));
  };
  /** A split's review turn ended, with checks off: ready as it is. */
  const reviewed = async (m: Manager, sid: string, st: SessionState | null) => {
    reviewing.delete(sid);
    if (checksWork(m)) return;
    const item = d.readyOf ? await d.readyOf(sid, MAIN_LANE).catch(() => null) : null;
    if (!item) return;
    const title = st?.title || "a big task";
    await d.managers.update(m.id, (cur) => logged(withReady(cur, { ...item, at: now() }), { at: now(), kind: "checked", text: `"${title}" is ready: its parts are together`, sid, lane: MAIN_LANE }));
    d.notify?.(m, { kind: "ready", item: { ...item, at: now() } });
    await goalMoved(m, sid, "ready");
  };

  /** Crossovers told once each: `${from}>${to}:${paths}`. */
  const crossTold = new Set<string>();
  /** Files this thread changed that another thread in the project, still working, is about to change: the Captain tells it. */
  const crossovers = async (m: Manager, sid: string, lane: string, st: SessionState | null) => {
    if (!m.on || m.level === "watch" || !st) return;
    const rel = (s2: SessionState, l: string, p: string) => {
      const base = (s2.engines[l]?.cwd ?? "").replace(/[\\/]+$/, "");
      return base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
    };
    const changed = (st.wrote?.[lane] ?? st.intents?.[lane]?.paths ?? []).map((p) => rel(st, lane, p));
    if (!changed.length) return;
    const others: { sid: string; lane: string; paths: string[] }[] = [];
    for (const other of await d.sessions(await d.me())) {
      if (ownSessions.has(other)) continue;
      const os = other === sid ? st : await d.state(other).catch(() => null);
      if (!os) continue;
      for (const l of Object.keys(os.engines)) {
        if ((other === sid && l === lane) || statusAt(os, l) !== "running") continue;
        const f = laneFolder(os, l);
        if (!f || d.folderKey(f) !== m.project.key) continue;
        const paths = [...(os.intents?.[l]?.paths ?? []), ...(os.claims ?? []).filter((c) => c.lane === l).map((c) => c.path)].map((p) => rel(os, l, p));
        if (paths.length) others.push({ sid: other, lane: l, paths });
      }
    }
    for (const o of crossoverOf(changed, others).slice(0, 2)) {
      const key = `${sid}:${lane}>${o.sid}:${o.lane}:${o.paths.join(",")}`;
      if (crossTold.has(key)) continue;
      crossTold.add(key);
      await wake(m, { kind: "crossover", sid, lane, detail: o.paths.join(", "), hard: false, other: { sid: o.sid, lane: o.lane } });
    }
  };

  /**
   * Its coding tool or model changed: a new tool starts in a session of its own on its next wake (the old lane stopped); a new
   * model restarts its lane, keeping its conversation.
   */
  const retool = async (had: Manager, next: Manager) => {
    // On the new flow its session holds its agents: the new tool goes on its own lane there, not in a fresh session.
    if (had.tool !== next.tool && next.autonomy && next.sid && next.lane && next.on) {
      const me = await d.me();
      await d.startTool(next.sid, me, { tool: next.tool, cwd: next.project.folder, model: next.model, lane: next.lane, project: next.project.name });
      onModel.set(next.id, next.model);
      return;
    }
    if (had.tool !== next.tool) {
      await stopIt(had);
      await d.managers.update(next.id, (cur) => {
        const { sid: _s, lane: _l, ...rest } = cur;
        return rest as Manager;
      });
      if (had.sid) ownSessions.add(had.sid);
      return;
    }
    if (had.model !== next.model && next.sid && next.lane && next.on) {
      const me = await d.me();
      await d.startTool(next.sid, me, { tool: next.tool, cwd: next.project.folder, model: next.model, lane: next.lane, project: next.project.name });
      onModel.set(next.id, next.model);
    }
  };

  /** One event appended anywhere: does it concern a Manager? */
  const hear = async (sid: string, ev: SessionEvent): Promise<Wake | null> => {
    const list = await d.managers.list();
    if (!list.length) return null;
    // One of its agents' lanes (Captain v2): its plan's, read by plain code; never the Captain's chat, never the old paths.
    const pt = planThread(list, sid, ev.lane ?? MAIN_LANE);
    if (pt) {
      // An agent's tool marked gone mid-task: started again and told to carry on, as the minute's look would, but now.
      if (ev.body.type === "engine.detached" && pt.task.status === "running" && pt.plan.status === "running") await carryOn(pt.m, pt.plan, pt.task).catch((e: Error) => say(`[plans] revive: ${e.message}`));
      const st = await d.state(sid);
      await taskEvent(pt.m, pt.plan, pt.task, ev, st).catch((e: Error) => say(`[plans] ${e.message}`));
      if (ev.body.type === "proof.tests" || (ev.body.type === "proof.status" && ev.body.stage === "failed")) await planCheck(pt.m, pt.plan, pt.task, ev.seq).catch((e: Error) => say(`[plans] check result: ${e.message}`));
      if (ev.body.type === "folder.committed" && !ev.body.error && (pt.m.ready ?? []).some((r) => r.sid === sid && r.lane === pt.task.lane)) await doneReady(pt.m, sid, pt.task.lane);
      return null;
    }
    // Its own session: its reply at the end of a turn.
    const own = list.find((m) => m.sid === sid);
    if (own) {
      // Only its own lane is the Captain: other lanes here are its agents' (or were).
      if ((ev.lane ?? MAIN_LANE) !== (own.lane ?? MAIN_LANE)) return null;
      // Its tool marked gone (a drop is only written down after the hub's grace, so a message sent just before found it still
      // "online" and waited for a tool that wasn't coming): started again now when something waits on it. The audit's revive test,
      // 2026-11-27, Arun's edge Captain.
      if (ev.body.type === "engine.detached" && (replying.has(own.id) || agentAsks.has(own.id) || replanAsks.has(own.id) || reportAsks.has(own.id))) await revive(own.id, sid, ev.lane ?? MAIN_LANE);
      if (ev.body.type === "run.ended") await heardReply(own, sid, ev.lane ?? MAIN_LANE);
      if (ev.body.type === "run.started" && own.stall) await d.managers.update(own.id, (cur) => (cur.stall ? (({ stall: _s, ...rest }) => rest as Manager)(cur) : null));
      // The check of a plan's whole, run on its own lane (the project folder).
      if (ev.body.type === "proof.tests" || (ev.body.type === "proof.status" && ev.body.stage === "failed")) await finalRead(own, sid, ev.lane ?? MAIN_LANE, ev.seq).catch((e: Error) => say(`[plans] final check: ${e.message}`));
      if (ev.body.type === "agent.usage") {
        const u = ev.body;
        // Priced at what the turn ran on: the usage's own model, else the lane's now (a step-up), never only its everyday one (the
        // audit, 2026-11-27: four turns read $0.0062 against its lane's $0.0622).
        // The lane's model as its tool reported it is what the page's Cost prices too, so the two agree.
        const lane = (await d.state(sid).catch(() => null))?.engines[ev.lane ?? MAIN_LANE]?.model;
        const model = u.model || (lane && lane !== "auto" ? lane : "") || onModel.get(own.id) || undefined;
        await d.managers.update(own.id, (cur) => withSpend(cur, { ...u, ...(model && model !== "auto" ? { model } : {}) }, now()));
      }
      return null;
    }
    if (ev.actor.id === "friday" && ev.body.type === "instruction") return null;
    const lane = ev.lane ?? MAIN_LANE;
    const st = await d.state(sid);
    const folder = laneFolder(st, lane);
    if (!folder) return null;
    const m = list.find((x) => x.project.key === d.folderKey(folder));
    if (!m) return null;
    // A split's end: checked, then ready for you; or why it couldn't be done, for you.
    if (ev.body.type === "hub.ended" && st?.options.byCaptain === m.id) {
      await splitEnded(m, sid, ev.body, st).catch((e: Error) => say(`[managers] split end: ${e.message}`));
      return null;
    }
    // A task's part (a hub's lane): the hub runs, grades, retries and brings it together. Only what it asks is the Captain's.
    const part = isPart(st, lane);
    // On Run, a thread that stopped on an error (not a usage limit) is asked once to try again, with no Captain turn spent.
    if (!part && ev.body.type === "run.ended" && ev.body.outcome === "error" && m.on && m.level === "run" && !d.limitHit(ev.body.error ?? "")) {
      const k = `${sid}:${lane}`;
      const last = retried.get(k);
      if (last === undefined || now() - last > RETRY_WINDOW_MS) {
        retried.set(k, now());
        const title = st?.title || "a thread";
        const err = (ev.body.error ?? "").slice(0, 200);
        setTimeoutFn(() => void d.tell(sid, lane, `The last turn stopped on an error${err ? ` (${err})` : ""}. Try that again, carrying on where you were.`).catch(() => false), d.retryMs ?? RETRY_MS);
        await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Asked "${title}" to try again after an error`, sid, lane }));
        return null;
      }
    }
    // Shipped: committed (and pushed or a PR) from the thread, its ready card goes.
    if (ev.body.type === "folder.committed" && !ev.body.error) {
      if ((m.ready ?? []).some((r) => r.sid === sid)) await doneReady(m, sid);
      await goalMoved(m, sid, "shipped");
    }
    if (ev.body.type === "run.ended" && ev.body.outcome === "done" && m.queue.length) await startQueued(m).catch((e: Error) => say(`[managers] queue: ${e.message}`));
    // A turn that ended asking in plain text (how coding tools ask) is a question too; one that ended asking leave to go on, or
    // with its plan unfinished, is work the Captain can keep going.
    const ended = ev.body.type === "run.ended" && ev.body.outcome !== "error";
    const w = part ? (ev.body.type === "agent.question" ? wakeFor(m, sid, ev, d.limitHit) : null) : (wakeFor(m, sid, ev, d.limitHit) ?? (ended ? (asksWake(m, sid, lane, st?.asks?.[lane]) ?? (await turnEnd(m, sid, lane, st))) : null));
    if (part) {
      if (w) await wake(m, w);
      return w;
    }
    if (w) await wake(m, w);
    if (ended) await crossovers(m, sid, lane, st).catch((e: Error) => say(`[managers] crossover: ${e.message}`));
    // Done with nothing to ask: its work is checked; and a check's result, read.
    if (ended && !w && ev.body.type === "run.ended" && ev.body.outcome === "done") await checkEnd(m, sid, lane, ev.seq, st);
    if (ev.body.type === "run.ended" && lane === MAIN_LANE && reviewing.has(sid)) await reviewed(m, sid, st);
    if (ev.body.type === "proof.tests" || (ev.body.type === "proof.status" && ev.body.stage === "failed")) await checkRead(m, sid, lane, ev.seq, st).catch((e: Error) => say(`[managers] check result: ${e.message}`));
    return w;
  };

  /**
   * The minute's look: lanes in a managed project that have been running with nothing new for STUCK_MS wake their Manager once per
   * stretch; a Manager on Run with a queue and a quiet project starts the next task.
   */
  const tick = async (): Promise<void> => {
    const list = (await d.managers.list()).filter((m) => m.on);
    if (!list.length) return;
    const me = await d.me();
    const byKey = new Map(list.map((m) => [m.project.key, m]));
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      const running = Object.keys(st.engines).filter((l) => statusAt(st, l) === "running").map((l) => [l, runAt(st, l)!] as const);
      if (!running.length) continue;
      const evs = await d.events(sid);
      for (const [lane] of running) {
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m || m.level === "watch") continue;
        const last = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane);
        if (!last || now() - last.ts < STUCK_MS) continue;
        const k = `${sid}:${lane}`;
        if (stuckTold.get(k) === last.seq) continue;
        stuckTold.set(k, last.seq);
        await stuckRung(m, sid, lane, st, evs, me);
      }
    }
    for (const m of list) if (m.level === "run" && m.queue.length) await startQueued(m).catch((e: Error) => say(`[managers] queue: ${e.message}`));
    // Running plans: what a restart or a lost event left stale put right, and what quiet hours or a usage limit held back, started
    // now (plain code, no Captain turn).
    for (const m of list) if (m.autonomy && putAwayOld(m, now())) await putAway(m.id).catch((e: Error) => say(`[plans] put away: ${e.message}`));
    await recoverPlans((await d.managers.list()).filter((x) => x.on)).catch((e: Error) => say(`[plans] recover: ${e.message}`));
    for (const m of await d.managers.list()) for (const p of m.plans ?? []) if (m.on && p.status === "running") await advance(m, p.id).catch((e: Error) => say(`[plans] advance: ${e.message}`));
    await missionLook((await d.managers.list()).filter((m) => m.on && m.level === "run")).catch((e: Error) => say(`[missions] look: ${e.message}`));
    await tidy(list, me).catch((e: Error) => say(`[managers] tidy: ${e.message}`));
    await awayLook(list).catch((e: Error) => say(`[managers] away: ${e.message}`));
    await lookOver(list, me).catch((e: Error) => say(`[managers] look: ${e.message}`));
  };

  /**
   * Its look over the whole project, every LOOK_MS, with no Captain turn (Arun, 2026-11-25: "it only reacts… it never looks over the
   * whole project"): its notices kept for the panel; two working threads about to change the same files woken about once (Help and
   * Run), so it tells them; and, once a day after DIGEST_HOUR, a digest in its conversation and on your phone.
   */
  const lookOver = async (list: readonly Manager[], me: Me) => {
    const due = list.filter((m) => !m.lookedAt || now() - m.lookedAt >= (d.lookMs ?? LOOK_MS));
    if (!due.length) return;
    const byKey = new Map(due.map((m) => [m.project.key, m]));
    const found = new Map<string, Notice[]>(due.map((m) => [m.id, []]));
    const counts = new Map<string, { running: number; waiting: number }>(due.map((m) => [m.id, { running: 0, waiting: 0 }]));
    /** Working lanes' planned files, by project: for overlaps. */
    const working = new Map<string, { sid: string; lane: string; title: string; paths: string[] }[]>();
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      let evs: SessionEvent[] | null = null;
      // Its pull request merged (Arun, 2026-11-25: "after merge… tidies up"): on Run with tidying on, its tools are stopped (its copy
      // left for Storage's own clean-up, which takes merged copies), its ready card cleared, its goal's thread shipped. Said once.
      const owner = Object.keys(st.engines).map((l) => laneFolder(st, l)).find(Boolean) ?? null;
      const pm = owner ? byKey.get(d.folderKey(owner)) : undefined;
      if (pm && tidiesIdle(pm) && st.pr?.url && !mergedTold.has(sid)) {
        const merged = st.pr.merged || (d.prState ? (await d.prState(sid, st.pr.url).catch(() => null)) === "merged" : false);
        if (merged) {
          mergedTold.add(sid);
          for (const [lane, e] of Object.entries(st.engines)) if (e.online && statusAt(st, lane) !== "running") await d.stop(sid, me, lane).catch(() => {});
          await d.managers.update(pm.id, (cur) => logged(clearReady(cur, sid) ?? cur, { at: now(), kind: "said", text: `"${st.title || "a thread"}" merged: stopped its tools`, sid }));
          await goalMoved(pm, sid, "shipped");
          continue;
        }
      }
      for (const lane of Object.keys(st.engines)) {
        if (isPart(st, lane)) continue;
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m) continue;
        const title = st.title || "a thread";
        const status = statusAt(st, lane);
        const c = counts.get(m.id)!;
        if (status === "running") {
          c.running++;
          const base = (st.engines[lane]?.cwd ?? "").replace(/[\\/]+$/, "");
          const rel = (p: string) => (base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p);
          const paths = [...(st.intents?.[lane]?.paths ?? []), ...(st.claims ?? []).filter((x) => x.lane === lane).map((x) => x.path)].map(rel);
          if (paths.length) working.set(m.id, [...(working.get(m.id) ?? []), { sid, lane, title, paths }]);
          continue;
        }
        evs ??= await d.events(sid);
        const last = evs.findLast((x) => (x.lane ?? MAIN_LANE) === lane);
        const since = last ? now() - last.ts : 0;
        const asks = !!st.asks?.[lane]?.questions.length || !!st.approvals?.[lane];
        if (asks) c.waiting++;
        if (asks && since >= WAITING_MS) found.get(m.id)!.push({ id: `waiting:${sid}:${lane}`, kind: "waiting", text: `"${title}" has waited on you ${Math.round(since / 3600_000)}h`, sid, at: now() });
        else if (!asks && st.diffs?.[lane]?.files.length && since >= UNSHIPPED_MS && !(m.ready ?? []).some((r) => r.sid === sid))
          found.get(m.id)!.push({ id: `unshipped:${sid}:${lane}`, kind: "unshipped", text: `"${title}" has changes nobody shipped, ${Math.round(since / 86_400_000) || 1}d old`, sid, at: now() });
      }
    }
    for (const m of due) {
      const notes = found.get(m.id)!;
      // Two working threads about to change the same files.
      const w = working.get(m.id) ?? [];
      for (let i = 0; i < w.length; i++)
        for (let j = i + 1; j < w.length; j++) {
          const a = w[i]!, b = w[j]!;
          if (a.sid === b.sid && a.lane === b.lane) continue;
          const both = a.paths.filter((p) => b.paths.includes(p)).slice(0, 4);
          if (!both.length) continue;
          notes.push({ id: `overlap:${a.sid}:${a.lane}:${b.sid}:${b.lane}`, kind: "overlap", text: `"${a.title}" and "${b.title}" are both about to change ${both.join(", ")}`, sid: a.sid, at: now() });
          const key = `${a.sid}:${a.lane}>${b.sid}:${b.lane}:${both.join(",")}`;
          if (m.level !== "watch" && !crossTold.has(key)) {
            crossTold.add(key);
            await wake(m, { kind: "crossover", sid: a.sid, lane: a.lane, detail: both.join(", "), hard: false, other: { sid: b.sid, lane: b.lane } });
          }
        }
      // Ready work that reads risky.
      for (const r of m.ready ?? []) if (r.risk === "high") notes.push({ id: `risky:${r.sid}:${r.lane}`, kind: "risky", text: `"${r.title}" is ready but reads risky: ${r.why}`, sid: r.sid, at: now() });
      const day = dayOf(now());
      const c = counts.get(m.id)!;
      // Once a day, what stands, said only when there is something to say: "all quiet" in its conversation and on your phone was
      // noise (Arun's first look at the window, 2026-11-25, read "Today in edge: all quiet." and nothing else). The day counts as
      // done either way, so it isn't worked out again at every look.
      const dueDigest = m.on && m.digestDay !== day && new Date(now()).getHours() >= DIGEST_HOUR && !inQuiet(m, now());
      const standing = dueDigest ? [(m.ready?.length ?? 0) && `${m.ready!.length} ready to ship`, c.waiting + openAsks(m, now()).length && `${c.waiting + openAsks(m, now()).length} waiting on you`, c.running && `${c.running} running`, m.queue.length && `${m.queue.length} queued`, notes.filter((n) => n.kind === "unshipped").length && `${notes.filter((n) => n.kind === "unshipped").length} unshipped`, (m.goals ?? []).filter((g) => g.status === "working").length && `${(m.goals ?? []).filter((g) => g.status === "working").length} goal${(m.goals ?? []).filter((g) => g.status === "working").length === 1 ? "" : "s"} under way`].filter(Boolean).join(", ") : "";
      const digest = standing ? `Today in ${m.project.name}: ${standing}.` : null;
      await d.managers.update(m.id, (cur) => {
        let next: Manager = { ...cur, notices: notes, lookedAt: now() };
        if (dueDigest) next = { ...next, digestDay: day };
        if (digest) next = withChat(next, "captain", digest, now());
        return next;
      });
      const about = notes[0]?.sid ?? m.ready?.[0]?.sid;
      if (digest && about) d.notify?.(m, { kind: "report", text: digest, sid: about });
    }
  };

  /**
   * The person's Away, as each Captain keeps it: begun (when it began and is to end), moved, or over (when they came back). Over,
   * what it did meanwhile goes to their phone in a line if they're not at the computer; the panel shows it in full.
   */
  const awayLook = async (list: readonly Manager[]) => {
    if (!d.away) return;
    const a = await d.away().catch(() => null);
    const on = a && a.until > now() ? a : null;
    for (const m of list) {
      const had = m.away;
      if (on && (!had || had.back !== undefined || had.since !== on.since || had.until !== on.until)) {
        await d.managers.update(m.id, (cur) => ({ ...cur, away: { since: on.since, until: on.until } }));
      } else if (!on && had && had.back === undefined) {
        const back = Math.min(now(), had.until);
        const next = await d.managers.update(m.id, (cur) => (cur.away && cur.away.back === undefined ? { ...cur, away: { ...cur.away, back } } : null));
        const report = next ? awayReport(next, now()) : null;
        const about = report && (report.waiting[0]?.sid ?? report.ready[0]?.sid ?? report.decided[0]?.sid);
        if (report && about && d.notify) d.notify(m, { kind: "report", text: awayLineFor(report), sid: about });
      }
    }
  };

  /**
   * Idle threads in a project whose Captain tidies (Run): a lane whose tool is on but quiet for IDLE_MS, not running, not waiting
   * on the person, in a session they don't have open, has its tool stopped. Its folder and history stay; opening the thread starts
   * it again. Never the Captain's own, never a split's parts (the hub's).
   */
  const tidy = async (list: readonly Manager[], me: Me) => {
    const tidying = list.filter(tidiesIdle);
    if (!tidying.length) return;
    const byKey = new Map(tidying.map((m) => [m.project.key, m]));
    const idle = d.idleMs ?? IDLE_MS;
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      const lanes = Object.entries(st.engines).filter(([lane, e]) => e.online && e.tool && !isPart(st, lane));
      if (!lanes.length) continue;
      let evs: SessionEvent[] | null = null;
      let viewed: boolean | null = null;
      for (const [lane, e] of lanes) {
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m) continue;
        if (statusAt(st, lane) !== "idle" || st.asks?.[lane]?.questions.length) continue;
        evs ??= await d.events(sid);
        const last = evs.findLast((x) => (x.lane ?? MAIN_LANE) === lane);
        if (!last || now() - last.ts < idle) continue;
        viewed ??= d.viewing ? await d.viewing(sid).catch(() => true) : false;
        if (viewed) break;
        await d.stop(sid, me, lane);
        const hours = Math.round((now() - last.ts) / 3600_000);
        await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Stopped ${e.tool ? (TOOL_LABEL[e.tool] ?? e.tool) : "the tool"} in "${st.title || "a thread"}", quiet ${hours ? `${hours}h` : "a while"}; it starts again when you open the thread`, sid, lane }));
      }
    }
  };

  /**
   * Each Captain's threads for its window (the UI session's redesign, 2026-11-25): the project's own threads, never the Captain's
   * own session, the sessions it started for itself or a split's parts. A thread is working while a lane runs, needs while a lane
   * waits on the person (a question or a go-ahead), stopped when its tools are all stopped (tidied, or by hand), and idle otherwise;
   * since is when that last changed. Newest first, twelve at most. Read from session state alone, no events, and kept 3 s.
   */
  let threadsKept: { at: number; by: Map<string, ManagerThread[]> } | null = null;
  const threadsOf = async (list: readonly Manager[], me: Me): Promise<Map<string, ManagerThread[]>> => {
    if (threadsKept && now() - threadsKept.at < 3000) return threadsKept.by;
    const byKey = new Map(list.map((m) => [m.project.key, m]));
    const by = new Map<string, ManagerThread[]>(list.map((m) => [m.id, []]));
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st || st.options?.manager) continue;
      const lanes = Object.keys(st.engines).filter((l) => !isPart(st, l));
      const mine = lanes.filter((l) => {
        const f = laneFolder(st, l);
        return !!f && byKey.has(d.folderKey(f));
      });
      if (!mine.length) continue;
      const m = byKey.get(d.folderKey(laneFolder(st, mine[0]!)!))!;
      const run = (l: string) => runAt(st, l);
      const running = mine.filter((l) => run(l)?.status === "running");
      const needs = mine.filter((l) => st.asks?.[l]?.questions.length || st.approvals?.[l]);
      const withTool = mine.filter((l) => st.engines[l]?.tool);
      const state: ManagerThread["state"] = running.length ? "working" : needs.length ? "needs" : withTool.length && withTool.every((l) => !st.engines[l]!.online) ? "stopped" : "idle";
      const pick = state === "working" ? running : state === "needs" ? needs : mine;
      const since = Math.max(0, ...pick.map((l) => run(l)?.sinceAt ?? 0));
      const main = mine.includes(MAIN_LANE) ? MAIN_LANE : mine[0]!;
      const tool = st.engines[main]?.tool;
      const ask = state === "needs" ? needs.map((l) => st.approvals?.[l]?.items[0]).find(Boolean) : undefined;
      // Its question, when what it waits on is an answer rather than a go-ahead (2026-11-28: a thread that asked was "waiting on your go-ahead").
      const question = state === "needs" && !ask ? needs.map((l) => st.asks?.[l]?.questions[0]?.question).find(Boolean) : undefined;
      by.get(m.id)!.push({ sid, title: st.title || "A thread", state, since, ...(tool ? { tool } : {}), ...(ask ? { ask } : {}), ...(question ? { question: question.slice(0, 300) } : {}) });
    }
    for (const [id, ts] of by) by.set(id, ts.sort((a, b) => b.since - a.since).slice(0, 12));
    threadsKept = { at: now(), by };
    return by;
  };

  /**
   * Projects worth a Captain (Arun, 2026-11-25: "how to get it started… getting started is hidden"): two or more of the person's
   * threads working in one folder in the last three days, none with a Captain yet, not put away. Busiest first.
   */
  const suggest = async (me: Me, putAway: ReadonlySet<string>): Promise<{ key: string; name: string; folder: string; threads: number; running: number }[]> => {
    const have = new Set((await d.managers.list()).map((m) => m.project.key));
    const by = new Map<string, { key: string; name: string; folder: string; sids: Set<string>; running: number }>();
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st || st.options?.manager) continue;
      const evs = await d.events(sid).catch(() => [] as SessionEvent[]);
      if (!evs.length || now() - evs.at(-1)!.ts > 3 * 86_400_000) continue;
      for (const lane of Object.keys(st.engines)) {
        const f = laneFolder(st, lane);
        if (!f) continue;
        const key = d.folderKey(f);
        if (have.has(key) || putAway.has(key)) continue;
        const p = by.get(key) ?? { key, name: f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f, folder: f, sids: new Set<string>(), running: 0 };
        p.sids.add(sid);
        if (statusAt(st, lane) === "running") p.running++;
        by.set(key, p);
      }
    }
    return [...by.values()]
      .filter((p) => p.sids.size >= 2)
      .map((p) => ({ key: p.key, name: p.name, folder: p.folder, threads: p.sids.size, running: p.running }))
      .sort((a, b) => b.threads - a.threads || b.running - a.running)
      .slice(0, 5);
  };

  /** The Recap's Record: a proof clip of what the plan changed, made now. False when nothing it changed draws a page. */
  const provePlan = async (m: Manager, pid: string): Promise<boolean> => {
    const plan = planOf(m, pid);
    if (!plan || !m.sid || !d.prove) return false;
    return d.prove(m.sid, m.lane ?? MAIN_LANE, pid, { asked: true, summary: m.goals?.find((g) => g.id === plan.goal)?.title ?? "" });
  };
  return { provePlan, seenPlan, redoTask, startPlan, cancelPlan, keepAgent, advance, goBring, liveOf, startGuard, putAway, startMission, pauseMission, stopMission, runMissions, threadsOf, suggest, sayTo, cancelGoal, doneReady, ensure, stop: stopIt, hear, tick, startQueued, wake, flush, answer, retool, forFolder, ownSessions, runningIn };
}

export type ManagersRun = ReturnType<typeof managersRun>;
export const newSid = () => randomBytes(6).toString("base64url");
/** A plan task taken but given no lane this long (a restart mid-start) goes back to the queue; a lane told nothing gets its brief again. */
export const RECOVER_MS = 3 * 60_000;
/** A check of the whole with nothing heard from it this long is given up on (its result missed across a restart). */
/** Criteria checks Friday runs itself per judgement (judged). */
export const CHECKS_MAX = 6;
/** A goal's check for a criterion by its words, as the Captain may have reworded it: the same words, or one inside the other. */
export function checkFor(goal: Pick<Goal, "checks"> | undefined, text: string): string | undefined {
  const all = Object.entries(goal?.checks ?? {});
  const t = text.toLowerCase().trim();
  return (all.find(([k]) => k.toLowerCase() === t) ?? all.find(([k]) => t.includes(k.toLowerCase()) || k.toLowerCase().includes(t)))?.[1];
}
/** How long a detached lane started again is waited for, before work through it is given up (reattach). */
export const REATTACH_MS = 20_000;
export const FINAL_STALE_MS = 20 * 60_000;
/** An agent's lane running with nothing new this long is said in the chat, once. */
export const QUIET_MS = 30 * 60_000;
/** How long the Captain's lane has to start a run on the person's message before the chat says it couldn't. */
export const START_GUARD_MS = 30_000;

/** A step's kind, for the Captain's live line: from its tool's common name (the adapters give coding tools' calls these names). */
export type WorkStepKind = "read" | "edit" | "run" | "search" | "web" | "think" | "other";
const STEP_KINDS: Record<string, WorkStepKind> = {
  read: "read", read_file: "read", list_files: "read", tree: "read", read_background: "read", mcp__friday__read_session: "read",
  edit: "edit", edit_file: "edit", write: "edit", write_file: "edit",
  shell: "run", run_command: "run", run_background: "run", stop_background: "run",
  search: "search", search_code: "search",
  web_search: "web", web_fetch: "web", fetch_url: "web",
  todo: "think", update_plan: "think", TodoWrite: "think",
};
export const workStepKind = (name: string): WorkStepKind => STEP_KINDS[name] ?? (/^mcp__.*__(read|list|get)/.test(name) ? "read" : "other");

/** The Captain's own lane at work, for its page (Arun, 2026-11-27: "don't just have it at thinking"). */
export interface CaptainWork {
  state: "running" | "waiting" | "idle" | "errored";
  /** When this turn began. */
  since?: number;
  /** Its latest step in words ("Reading routes/orders.ts", "Thinking about what to do next"). */
  activity?: string;
  /** This turn's steps, the last WORK_STEPS: each tool call, done once its result is in. */
  steps?: { at: number; kind: WorkStepKind; text: string; done: boolean }[];
  /** This turn's tokens so far. */
  tokens?: number;
  /** Why it's errored, when its lane couldn't start a run on the person's message (Manager.stall). */
  reason?: string;
}
export const WORK_STEPS = 8;

/**
 * One lane's turn now, from its events and its run's status: its state, when the turn began, what it's doing in words (the same
 * words the sessions use, activity-line doingNow and step-words), its steps and the tokens it has used. Pure.
 */
export function laneWork(events: readonly SessionEvent[], lane: string, run: { status: string } | undefined): CaptainWork {
  const state: CaptainWork["state"] = run?.status === "running" ? "running" : run?.status === "waiting_for_human" ? "waiting" : run?.status === "error" ? "errored" : "idle";
  const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const at = mine.findLastIndex((e) => e.body.type === "run.started");
  if (at < 0) return { state };
  const turn = mine.slice(at);
  const answered = new Set(turn.flatMap((e) => (e.body.type === "tool.result" ? [e.body.callId] : [])));
  const steps = turn.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls.map((c) => ({ at: e.ts, kind: workStepKind(c.name), text: doingWords(callDoing(c)), done: answered.has(c.id) })) : [])).slice(-WORK_STEPS);
  const tokens = turn.reduce((n, e) => n + (e.body.type === "agent.usage" ? e.body.input + e.body.output : 0), 0);
  const doing = state === "running" ? doingNow(mine as SessionEvent[], lane) : null;
  const activity = doing?.text ?? steps.at(-1)?.text;
  return { state, since: turn[0]!.ts, ...(activity ? { activity } : {}), ...(steps.length ? { steps } : {}), ...(tokens ? { tokens } : {}) };
}

