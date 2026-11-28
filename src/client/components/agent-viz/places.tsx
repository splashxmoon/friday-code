// The four agent pictures where they sit in the app, each fed from what that place already has (no new reads): a Captain's goal as
// its crew (the Captain window), every Captain as a fleet (the Agent Board), a session's subagents as crews (the status bar's
// tray), an agent at work as a monitor (the thread card's Agents, Running now), and a crew workflow's runs as a relay (its run card
// in the room). Each host loads this file lazily, so neither the first screen nor the session screen carries any of it.
import { useMemo, useState, type ReactNode } from "react";
import { describeCall } from "../../../activity-line.js";
import type { SessionState } from "../../../session/projection.js";
import type { RoomRun } from "../../../team-workflow-model.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, MAIN_LANE, type EngineTool, type Member, type SessionEvent } from "../../../types.js";
import { EngineMark } from "../../BrandMarks.js";
import { Icon, type IconName } from "../../icons.js";
import { useManagers, type ManagerView } from "../../Managers.js";
import type { Identity } from "../../storage.js";
import { BlobFace } from "../../teammate-face.js";
import { Face, useTeamNow } from "../../Teammates.js";
import { listOf } from "../../team-workflow-view.js";
import type { SubTask } from "../../Tasks.js";
import type { Send } from "../../useSession.js";
import { AgentCrew } from "./AgentCrew.js";
import { AgentFleet } from "./AgentFleet.js";
import { AgentHandoff } from "./AgentHandoff.js";
import { AgentMonitor } from "./AgentMonitor.js";
import { captainCrew, captainFleet, hubMonitor, sessionCrews, threadMonitor, workflowRelay, type HubLike, type Marks, type StepKind } from "./adapters.js";
import { useTick, type VizStatus } from "./viz-parts.js";

const STEP_ICON: Record<StepKind, IconName> = { read: "file", edit: "pencil", run: "terminalSquare", search: "search", web: "globe", ask: "message", hand: "handoff", check: "shield", git: "gitCommit", start: "play", say: "message", other: "zap" };
const marks: Marks = {
  engine: (t) => <EngineMark tool={t} size={13} />,
  step: (k) => <Icon name={STEP_ICON[k]} size={11} />,
  face: (seed) => (
    <span className="viz-face">
      <BlobFace seed={seed} size={18} hat />
    </span>
  ),
};
const names: Partial<Record<EngineTool, string>> = ENGINE_NAMES;

/** A Captain's goal as its crew: the Captain over the goal's threads; its switcher moves between the goals still on. */
export function CaptainCrew({ m, goal, open }: { m: ManagerView; goal?: string; open: (sid: string) => void }) {
  const now = useTick(true, 15_000);
  const [g, setG] = useState(goal);
  const crew = captainCrew(m, { goal: g, now, marks, names, open });
  // Inside its goal's card, which already names the goal: a header only when there are goals to switch between.
  return <AgentCrew {...crew} onProject={setG} titleIcon={<Icon name="flag" size={14} />} words={{ working: "Running", done: "Ready" }} label={`${m.project.name}'s crew`} className="viz-in-captain" bare={(crew.projects?.length ?? 0) < 2} />;
}

/** Every Captain side by side, each summing up its threads; a press on one opens its threads beside it. */
export function CaptainFleet({ identity, onOpen }: { identity: Identity; onOpen: (sid: string) => void }) {
  const { managers } = useManagers(identity);
  const now = useTick(true, 15_000);
  const agents = useMemo(() => captainFleet(managers, { now, marks, names, open: onOpen }), [managers, now, onOpen]);
  if (!managers.length)
    return (
      <p className="viz-empty" role="status">
        No Captains yet. Add one to a project in the sidebar and its threads show up here.
      </p>
    );
  return <AgentFleet agents={agents} title="Captains" words={{ working: "Running", done: "Ready" }} subWord={["thread", "threads"]} label="Every Captain and its threads" />;
}

/** One of a Captain's threads as a monitor, opened from Running now: its Log opens the Captain's window. */
export function ThreadMonitor({ m, sid, progress, onOpen, onPause, paused }: { m: ManagerView; sid: string; progress: { done: number; of: number } | null; onOpen: () => void; onPause?: () => void; paused?: boolean }) {
  const now = useTick(true, 5000);
  const t = m.threads?.find((x) => x.sid === sid);
  if (!t) return null;
  const p = threadMonitor(m, t, { now, marks, names, progress });
  return <AgentMonitor {...p} onLog={onOpen} logLabel="Open" {...(onPause ? { onPause, pauseLabel: paused ? "Carry on" : "Pause" } : {})} className="viz-in-running" />;
}

/** "Running npm test" → "Ran npm test": a step said as done, as the Agents hub says them. */
const PAST: Record<string, string> = { Reading: "Read", Looking: "Looked", Searching: "Searched", Editing: "Edited", Writing: "Wrote", Running: "Ran", Starting: "Started", Checking: "Checked", Fetching: "Fetched", Asking: "Asked", Handing: "Handed", Making: "Made", Adding: "Added", Using: "Used" };
/** One agent's finished steps, from its messages' tool calls (a failed result marks its step), newest last; the last 12. */
function laneSteps(events: readonly SessionEvent[], lane: string): { lane: string; text: string; ts: number; failed: boolean }[] {
  const out: { lane: string; text: string; ts: number; failed: boolean }[] = [];
  const byCall = new Map<string, (typeof out)[number]>();
  for (const e of events) {
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "agent.message")
      for (const c of b.toolCalls) {
        if (c.name === "update_plan" || c.name === "todo") continue;
        const step = { lane, text: describeCall(c).replace(/^\w+/, (w) => PAST[w] ?? w), ts: e.ts, failed: false };
        out.push(step);
        byCall.set(c.id, step);
      }
    else if (b.type === "tool.result" && b.isError) {
      const step = byCall.get(b.callId);
      if (step) step.failed = true;
    }
  }
  return out.slice(-12);
}

/**
 * The thread card's agent, opened: its monitor, live from the session (its step now, the steps it finished, a command it wants to
 * run with Run it and Don't, Stop). Answering is the same instruction the Agents hub sends.
 */
export function SessionAgentMonitor({ a, state, events, me, send, may, head }: { a: HubLike & { tokens?: number }; state: SessionState; events: SessionEvent[]; me: Member; send: Send; may: boolean; /** As a row of the agent list: folded to its top part, with these in its head. */ head?: { headEnd?: ReactNode; pillWrap?: (pill: ReactNode) => ReactNode; words?: Partial<Record<VizStatus, string>> } }) {
  const now = useTick(a.status === "working" || !!a.ask, 1000);
  const recent = useMemo(() => laneSteps(events, a.lane), [events, a.lane]);
  const model = a.model ? (a.tool ? (ENGINE_MODEL_INFO[a.tool]?.find((x) => x.id === a.model)?.label ?? a.model) : a.model) : undefined;
  const p = hubMonitor(a, recent, { now, marks, names, ...(model ? { model } : {}) });
  const lane = a.lane !== MAIN_LANE ? { lane: a.lane } : {};
  const answer = (approve: boolean) => void send({ type: "instruct", ...lane, text: approve ? (a.ask!.scope === "commands" ? "Yes, run it." : "Yes, go ahead.") : "No, don't.", approval: { id: a.ask!.id, approve }, quiet: true });
  return (
    <AgentMonitor
      {...p}
      {...(p.ask && may && a.ask ? { ask: { ...p.ask, onAllow: () => answer(true), onDecline: () => answer(false) } } : {})}
      {...(may ? { onCancel: () => void send({ type: "run.pause", ...lane }), cancelLabel: "Stop" } : {})}
      {...(head ? { collapse: "head" as const, folded: true, headEnd: head.headEnd, ...(head.pillWrap ? { pillWrap: head.pillWrap } : {}), words: { ...p.words, ...head.words } } : {})}
      className="viz-in-card"
    />
  );
}

/** The session's subagents as crews, in the status bar's tray: an agent's subagents under it, the switcher moving between agents. */
export function SessionCrew({ tasks, agentOf, onJump }: { tasks: SubTask[]; agentOf: (lane: string) => { name: string; tool?: EngineTool }; onJump: (seq: number) => void }) {
  const now = useTick(tasks.some((t) => t.status === "running"), 1000);
  const { lanes, crewOf } = sessionCrews(tasks, agentOf, { now, marks, names, jump: onJump });
  const [lane, setLane] = useState<string | null>(null);
  const at = lane && lanes.includes(lane) ? lane : lanes[0];
  if (!at) return null;
  const crew = crewOf(at);
  return (
    <AgentCrew
      {...crew}
      titleIcon={<Icon name="gitFork" size={14} />}
      projects={lanes.map((l) => ({ id: l, name: crewOf(l).title, working: tasks.filter((t) => t.lane === l && t.status === "running").length }))}
      onProject={setLane}
      label="Each agent's subagents"
      className="viz-in-tray"
    />
  );
}

/** A crew workflow's runs in this room as a relay of its crew mates: what each handed on, what was lost on the way. */
export function WorkflowRelay({ run, runs }: { run: RoomRun; runs: RoomRun[] }) {
  const team = useTeamNow();
  const mates = listOf<{ name: string; look?: string; role?: string }>(team?.teammates);
  const mine = runs.filter((r) => r.id === run.id);
  const relay = workflowRelay(mine.length ? mine : [run], {
    faceOf: (name) => {
      const m = mates.find((x) => x.name === name);
      return (
        <span className="viz-face">
          <Face seed={m?.look ?? name} size={18} />
        </span>
      );
    },
    roleOf: (name) => mates.find((x) => x.name === name)?.role ?? "",
  });
  if (relay.agents.length < 2) return <p className="viz-empty">The relay shows once two crew mates hand work on.</p>;
  return <AgentHandoff {...relay} label={`${run.name}: what each crew mate handed on`} className="viz-in-run" />;
}

/** A reply's subagents as a crew: the agent that sent them off over each one, live (its card in the chat, Subagents.tsx). */
export function ReplyCrew({ rows, lead }: { rows: { key: string; description: string; agentType?: string; state: "open" | "working" | "review" | "done" | "blocked"; start?: number; end?: number; summary?: string; doing?: string; steps?: number }[]; lead: { name: string; tool?: EngineTool } }) {
  const now = useTick(rows.some((r) => r.state === "working"), 1000);
  const STATE = { working: "running", review: "running", done: "done", blocked: "error", open: "stopped" } as const;
  const tasks = rows.map((r) => ({ key: r.key, lane: "lead", description: r.description, ...(r.agentType ? { agentType: r.agentType } : {}), status: STATE[r.state], ...(r.summary ? { summary: r.summary } : {}), ...(r.doing ? { doing: r.doing } : {}), ...(r.steps ? { steps: r.steps } : {}), start: r.start ?? now, ...(r.end ? { end: r.end } : {}), seq: 0 }));
  const { crewOf } = sessionCrews(tasks, () => lead, { now, marks, names });
  return <AgentCrew {...crewOf("lead")} titleIcon={<Icon name="gitFork" size={14} />} label={`${lead.name}'s subagents`} className="viz-in-tray" bare />;
}
