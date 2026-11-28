// What the four agent pictures are drawn from: Friday's own records, read as they already come to the page (a Captain and its
// threads, a session's agents and their subagents, a crew workflow's runs), never anything new asked of the server. Pure: the marks
// (a coding tool's logo, a step's icon, a mascot) are handed in, so the same rules are tested without a page.
import type { ReactNode } from "react";
import type { Goal, ManagerAct, ManagerThread } from "../../../managers.js";
import type { RoomRun, RoomRunStep } from "../../../team-workflow-model.js";
import type { EngineTool } from "../../../types.js";
import type { AgentCrewProps, CrewAgent } from "./AgentCrew.js";
import type { FleetAgent, FleetSub } from "./AgentFleet.js";
import type { AgentHandoffProps, HandoffAgent, HandoffItem } from "./AgentHandoff.js";
import type { AgentMonitorProps, MonitorStep } from "./AgentMonitor.js";
import { colorOf, type VizStatus, type VizTool } from "./viz-parts.js";

/** The kinds of step a coding tool takes, by the verb its words start with, each with its own mark. */
export type StepKind = "read" | "edit" | "run" | "search" | "web" | "ask" | "hand" | "check" | "git" | "start" | "say" | "other";
export interface Marks {
  engine: (tool: EngineTool | "") => ReactNode;
  step: (kind: StepKind) => ReactNode;
  face: (seed: string) => ReactNode;
}
const STEP_LABEL: Record<StepKind, string> = { read: "Read", edit: "Edit", run: "Terminal", search: "Search", web: "Web", ask: "Ask", hand: "Hand-off", check: "Check", git: "Git", start: "Start", say: "Note", other: "Step" };

/** "Edited login.js" → edit, "Ran npm test" → run, "git commit …" → git: a step's kind from its words. */
export function stepKind(text: string): StepKind {
  const t = text.trim().toLowerCase();
  if (/^(ran|running|run)\b.*\bgit\b|^git\b|\b(commit|push|pull request|branch)\b/.test(t)) return "git";
  if (/^(read|reading|opened|opening|viewed|viewing)\b/.test(t)) return "read";
  if (/^(edit|edited|editing|wrote|writing|write|created|creating|changed|changing|made|making|added|adding|updated|updating)\b/.test(t)) return "edit";
  if (/^(ran|running|run|started|starting) .*(test|build|npm|pnpm|yarn|tsc|make|cargo|pytest|node)\b|^(ran|running)\b/.test(t)) return "run";
  if (/^(searched|searching|search|looked|looking|grep|found|finding)\b/.test(t)) return "search";
  if (/^(fetched|fetching|browsed|browsing|visited|visiting)\b|https?:\/\//.test(t)) return "web";
  if (/^(asked|asking|waiting)\b/.test(t)) return "ask";
  if (/^(handed|handing|sent|sending)\b/.test(t)) return "hand";
  if (/^(checked|checking|tested|testing|reviewed|reviewing)\b/.test(t)) return "check";
  if (/^(started|starting)\b/.test(t)) return "start";
  return "other";
}
export const stepTool = (text: string, marks: Marks): VizTool => {
  const k = stepKind(text);
  return { id: k, label: STEP_LABEL[k], mark: marks.step(k) };
};

const sentence = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// ── A Captain and its threads ─────────────────────────────────────────────────────────────────────────────────────────────

/** A Captain as the pictures need it: its record and its threads as the window has them, its names and its ready work. */
export interface CaptainLike {
  id: string;
  look: string;
  on: boolean;
  project: { name: string };
  tool: EngineTool;
  model: string;
  goals?: Goal[];
  queue: { id: string; text: string; goal?: string; stage?: number }[];
  log: ManagerAct[];
  threads?: ManagerThread[];
  ready?: { sid: string; facts: string; summary: string[] }[];
  spend?: { day: string; usd: number; context?: number; window?: number };
}

/** A thread of a goal as it stands now: its live state over the goal's record (running only while it really runs). */
export function threadStatus(t: Goal["threads"][number], live: ManagerThread | undefined): VizStatus {
  if (t.state === "shipped" || t.state === "ready") return "done";
  if (live?.state === "working") return "working";
  if (live?.state === "needs" || t.state === "stuck") return "needs";
  return "idle";
}
const liveStatus = (t: ManagerThread): VizStatus => (t.state === "working" ? "working" : t.state === "needs" ? "needs" : "idle");

/** What a Captain asked for that is still on: missions first, then the newest goal. */
export const liveGoals = (m: Pick<CaptainLike, "goals">): Goal[] => (m.goals ?? []).filter((g) => g.status !== "done" && g.status !== "cancelled").sort((a, b) => Number(!!b.mission) - Number(!!a.mission) || b.at - a.at);

const lastAct = (m: CaptainLike, sid?: string) => m.log.filter((a) => (sid ? a.sid === sid : true) && a.kind !== "woke" && a.kind !== "skipped").sort((a, b) => b.at - a.at)[0];

/** Today's spend, when it is today's. */
const today = (m: CaptainLike, now: number) => (m.spend && m.spend.day === new Date(now).toLocaleDateString("en-CA") ? m.spend : undefined);

export function captainStatus(m: CaptainLike, now: number): VizStatus {
  const ts = m.threads ?? [];
  if (m.log.some((a) => a.kind === "for-you" && !a.answered && !a.dismissed && now - a.at < 86_400_000) || ts.some((t) => t.state === "needs")) return "needs";
  if (ts.some((t) => t.state === "working")) return "working";
  if (liveGoals(m).some((g) => g.status === "ready")) return "done";
  return "idle";
}

/**
 * A Captain's crew: the Captain on top, a goal's threads under it (each with its coding tool, what it is doing, and the task the
 * Captain handed it), its queued tasks after them; the switcher swaps between its goals. No goal picked: the first one still on.
 */
export function captainCrew(m: CaptainLike, o: { goal?: string; now: number; marks: Marks; open?: (sid: string) => void; names: Partial<Record<EngineTool, string>> }): Pick<AgentCrewProps, "lead" | "title" | "projects"> {
  const goals = liveGoals(m);
  const all = m.goals ?? [];
  const g = (o.goal ? all.find((x) => x.id === o.goal) : undefined) ?? goals[0] ?? all[0];
  const byId = new Map((m.threads ?? []).map((t) => [t.sid, t]));
  const ready = new Map((m.ready ?? []).map((r) => [r.sid, r]));
  const tool = (t?: EngineTool): VizTool[] => (t ? [{ id: t, label: o.names[t] ?? t, mark: o.marks.engine(t) }] : []);
  const kids: CrewAgent[] = [];
  for (const t of g?.threads ?? []) {
    const live = byId.get(t.sid);
    const status = threadStatus(t, live);
    const r = ready.get(t.sid);
    const act = lastAct(m, t.sid);
    const doing =
      status === "done" ? (r?.summary[0] ?? (t.state === "shipped" ? "Shipped" : "Ready for you")) : status === "needs" ? "Waiting on you" : status === "working" ? (act && act.kind !== "started" ? act.text : "Working on it") : live ? "Quiet" : "Not started";
    const started = m.log.find((a) => a.kind === "started" && a.sid === t.sid)?.at ?? live?.since ?? g!.at;
    kids.push({
      id: t.sid,
      name: sentence(live?.title || t.task),
      ...(live?.tool ? { model: o.names[live.tool] ?? live.tool } : {}),
      status,
      doing: clip(doing, 120),
      tools: tool(live?.tool),
      handed: { from: "Captain", text: clip(t.task, 80), at: started },
      color: colorOf(t.sid),
      ...(live?.tool ? { avatar: o.marks.engine(live.tool) } : {}),
      ...(o.open ? { actions: [{ label: "Open the thread", run: () => o.open!(t.sid) }] } : {}),
      facts: [...(t.stage != null && g?.mission ? [{ label: "Stage", value: String(t.stage + 1) }] : []), ...(r ? [{ label: "Checked", value: r.facts }] : [])],
    });
  }
  for (const q of m.queue.filter((q) => g && q.goal === g.id)) kids.push({ id: q.id, name: sentence(clip(q.text, 60)), status: "queued", doing: q.stage != null ? `Starts at stage ${q.stage + 1}` : "Starts when there's room", color: colorOf(q.id), handed: { from: "Captain", text: clip(q.text, 80), at: 0 } });
  const sp = today(m, o.now);
  const act = lastAct(m);
  const lead: CrewAgent = {
    id: m.id,
    name: m.project.name,
    model: `Captain · ${o.names[m.tool] ?? m.tool}`,
    status: captainStatus(m, o.now),
    // What it did last, not the goal again (its title heads the crew).
    doing: act ? clip(act.text, 100) : m.on ? "Watching the project" : "Off",
    ...(sp?.context && sp.window ? { context: { used: sp.context, max: sp.window } } : {}),
    tools: [...new Map(kids.flatMap((k) => k.tools ?? []).map((t) => [t.id, t])).values()],
    color: "blue",
    avatar: o.marks.face(m.look),
    children: kids,
    facts: [...(g?.mission ? [{ label: "Done when", value: g.mission.done }] : []), ...(sp ? [{ label: "Today", value: `$${sp.usd.toFixed(2)}` }] : [])],
  };
  return {
    lead,
    title: g?.title ?? m.project.name,
    projects: goals.map((x) => ({ id: x.id, name: x.title, working: x.threads.filter((t) => byId.get(t.sid)?.state === "working").length })),
  };
}

/** Every Captain side by side, each summing up its threads; a press opens its threads to the right. */
export function captainFleet(ms: CaptainLike[], o: { now: number; marks: Marks; open?: (sid: string) => void; openCaptain?: (id: string) => void; names: Partial<Record<EngineTool, string>> }): FleetAgent[] {
  return ms.map((m) => {
    const ts = m.threads ?? [];
    const goals = liveGoals(m);
    const taskOf = (sid: string) => goals.flatMap((g) => g.threads).find((t) => t.sid === sid)?.task;
    const subs: FleetSub[] = ts.map((t) => ({
      id: t.sid,
      name: sentence(t.title),
      ...(t.tool ? { model: o.names[t.tool] ?? t.tool, avatar: o.marks.engine(t.tool), tools: [{ id: t.tool, label: o.names[t.tool] ?? t.tool, mark: o.marks.engine(t.tool) }] } : {}),
      status: liveStatus(t),
      task: sentence(clip(taskOf(t.sid) ?? (t.state === "working" ? "Working" : t.state === "needs" ? "Waiting on you" : "Quiet"), 90)),
      ...(t.since && t.state === "working" ? { ms: Math.max(0, o.now - t.since) } : {}),
      color: colorOf(t.sid),
      ...(o.open ? { onOpen: () => o.open!(t.sid) } : {}),
      ...(t.state === "needs" && o.open ? { action: { label: "Open", run: () => o.open!(t.sid) } } : {}),
    }));
    const sp = today(m, o.now);
    const working = ts.filter((t) => t.state === "working");
    const oldest = Math.min(...working.map((t) => t.since || o.now));
    return {
      id: m.id,
      name: m.project.name,
      model: `Captain · ${o.names[m.tool] ?? m.tool}`,
      status: captainStatus(m, o.now),
      task: goals[0]?.title ?? lastAct(m)?.text ?? (m.on ? "Watching the project" : "Off"),
      tools: [...new Map(ts.filter((t) => t.tool).map((t) => [t.tool!, { id: t.tool!, label: o.names[t.tool!] ?? t.tool!, mark: o.marks.engine(t.tool!) }])).values()],
      ...(sp ? { cost: sp.usd } : {}),
      ...(working.length ? { ms: Math.max(0, o.now - oldest) } : {}),
      avatar: o.marks.face(m.look),
      color: colorOf(m.id),
      subs,
    };
  });
}

/**
 * One of a Captain's threads as a monitor: where it is (its live state and how long), the Captain's steps on it so far as finished
 * steps, the command when it waits on an OK, how far its goal is, and the Captain's window as its log.
 */
export function threadMonitor(m: CaptainLike, t: ManagerThread, o: { now: number; marks: Marks; names: Partial<Record<EngineTool, string>>; progress?: { done: number; of: number } | null }): Omit<AgentMonitorProps, "onLog" | "onPause"> {
  const acts = m.log.filter((a) => a.sid === t.sid && a.kind !== "woke" && a.kind !== "skipped").sort((a, b) => b.at - a.at);
  const kindOf = (a: ManagerAct): StepKind => (a.kind === "started" ? "start" : a.kind === "checked" ? "check" : a.kind === "sent-back" ? "hand" : a.kind === "for-you" ? "ask" : "say");
  const steps: MonitorStep[] = acts.slice(0, 8).map((a, i) => {
    const after = i === 0 ? (t.state === "working" ? o.now : a.at) : acts[i - 1]!.at;
    const k = kindOf(a);
    return { id: `${a.at}:${i}`, text: clip(a.text, 90), ms: Math.max(100, after - a.at), tool: { id: k, label: STEP_LABEL[k], mark: o.marks.step(k) }, at: a.at, note: a.text.length > 90 ? a.text : undefined };
  });
  const tool = t.tool ? { id: t.tool, label: o.names[t.tool] ?? t.tool, mark: o.marks.engine(t.tool) } : { id: "run", label: "Thread", mark: o.marks.step("run") };
  const status: VizStatus = t.state === "working" ? "working" : t.state === "needs" ? "needs" : "idle";
  return {
    name: sentence(t.title),
    subtitle: [m.project.name, t.tool ? o.names[t.tool] ?? t.tool : ""].filter(Boolean).join(" · "),
    avatar: o.marks.engine(t.tool ?? ""),
    status,
    words: { working: "Running", idle: t.state === "stopped" ? "Stopped" : "Idle" },
    ...(status === "working" ? { current: { key: `${t.sid}:${t.since}`, text: "Working on it", tool, since: t.since || o.now } } : {}),
    ...(status === "needs" ? { ask: { title: t.ask ? "Wants to run" : "Waiting on you", command: t.ask ?? "Open the thread to answer", tool, since: t.since } } : {}),
    steps,
    ...(o.progress ? { progress: { done: o.progress.done, total: o.progress.of } } : {}),
    started: acts.at(-1)?.at ?? t.since,
  };
}

// ── A session's agent and its subagents ───────────────────────────────────────────────────────────────────────────────────

/** A subagent as the session has it (Tasks.tsx SubTask), what the crew needs of it. */
export interface SubLike {
  key: string;
  lane: string;
  description: string;
  agentType?: string;
  status: "running" | "done" | "error" | "stopped";
  summary?: string;
  doing?: string;
  steps?: number;
  start: number;
  end?: number;
  seq: number;
}
const SUB_STATUS: Record<SubLike["status"], VizStatus> = { running: "working", done: "done", error: "failed", stopped: "idle" };

/**
 * A session's agents as crews: each agent that sent subagents off leads them, each subagent with what it was sent to do, what it is
 * doing or what it found, its steps and its time; the switcher swaps between the agents. Its lead, when the session has one, first.
 */
export function sessionCrews(subs: SubLike[], agentOf: (lane: string) => { name: string; tool?: EngineTool; model?: string; context?: { used: number; max: number } }, o: { now: number; marks: Marks; names: Partial<Record<EngineTool, string>>; jump?: (seq: number) => void; lead?: string }): { lanes: string[]; crewOf: (lane: string) => Pick<AgentCrewProps, "lead" | "title"> } {
  const lanes = [...new Set(subs.map((s) => s.lane))].sort((a, b) => Number(b === o.lead) - Number(a === o.lead) || Number(subs.some((s) => s.lane === b && s.status === "running")) - Number(subs.some((s) => s.lane === a && s.status === "running")));
  const crewOf = (lane: string) => {
    const a = agentOf(lane);
    const mine = subs.filter((s) => s.lane === lane).sort((x, y) => x.start - y.start);
    const kids: CrewAgent[] = mine.map((s) => {
      const st = SUB_STATUS[s.status];
      const took = (s.end ?? o.now) - s.start;
      return {
        id: s.key,
        name: clip(s.description, 48),
        ...(s.agentType && s.agentType !== "general-purpose" ? { model: s.agentType } : {}),
        status: st,
        doing: clip(st === "working" ? (s.doing ?? "Starting…") : (s.summary?.replace(/^\s*\[harness:[^\]]*\]\s*/i, "") ?? (st === "failed" ? "Failed" : st === "idle" ? "Stopped before it was done" : "Done")), 140),
        handed: { from: a.name, text: clip(s.description, 80), at: s.start },
        color: colorOf(s.key),
        facts: [{ label: "Took", value: took >= 60_000 ? `${Math.round(took / 60_000)}m` : `${Math.max(1, Math.round(took / 1000))}s` }, ...(s.steps ? [{ label: "Steps", value: String(s.steps) }] : [])],
        ...(o.jump ? { actions: [{ label: "Go to where it was sent", run: () => o.jump!(s.seq) }] } : {}),
      };
    });
    const working = mine.some((s) => s.status === "running");
    const lead: CrewAgent = {
      id: `lane:${lane}`,
      name: a.name,
      ...(a.model || a.tool ? { model: a.model ?? o.names[a.tool!] ?? a.tool } : {}),
      status: working ? "working" : mine.some((s) => s.status === "error") ? "failed" : "done",
      doing: working ? `Leading ${kids.filter((k) => k.status === "working").length} at work` : "All back",
      ...(a.context ? { context: a.context } : {}),
      ...(a.tool ? { tools: [{ id: a.tool, label: o.names[a.tool] ?? a.tool, mark: o.marks.engine(a.tool) }], avatar: o.marks.engine(a.tool) } : {}),
      color: "blue",
      children: kids,
    };
    return { lead, title: a.name };
  };
  return { lanes, crewOf };
}

/** A session agent as the hub has it (agents-hub.ts HubAgent), what its monitor needs. */
export interface HubLike {
  lane: string;
  name: string;
  tool: EngineTool | null;
  status: "working" | "waiting" | "paused" | "offline" | "limited" | "failed" | "done" | "ready";
  line: string;
  plan: { done: number; total: number } | null;
  startedAt: number | null;
  endedAt: number | null;
  model: string | null;
  branch: string | null;
  ask: { id: string; items: string[]; scope: string } | null;
  needsYou: boolean;
}
const HUB_STATUS: Record<HubLike["status"], VizStatus> = { working: "working", waiting: "needs", paused: "idle", offline: "idle", limited: "idle", failed: "failed", done: "done", ready: "idle" };

/** A session agent at work as a monitor: its step now, the steps it finished (with each one's kind), its command waiting on you. */
export function hubMonitor(a: HubLike, recent: { lane: string; text: string; ts: number; failed: boolean }[], o: { now: number; marks: Marks; names: Partial<Record<EngineTool, string>>; model?: string }): Omit<AgentMonitorProps, "onLog" | "onPause" | "onCancel"> {
  const mine = recent.filter((s) => s.lane === a.lane).sort((x, y) => y.ts - x.ts).slice(0, 12);
  const status: VizStatus = a.ask || a.needsYou ? "needs" : HUB_STATUS[a.status];
  const steps: MonitorStep[] = mine.map((s, i) => {
    const before = mine[i + 1]?.ts ?? a.startedAt ?? s.ts - 1000;
    return { id: `${s.ts}:${i}`, text: clip(s.text, 90), ms: Math.max(100, s.ts - before), tool: stepTool(s.text, o.marks), failed: s.failed, at: before, ...(s.text.length > 90 ? { note: s.text } : {}) };
  });
  const since = Math.max(a.startedAt ?? o.now, mine[0]?.ts ?? 0);
  const line = a.line || "Working";
  return {
    name: a.name,
    subtitle: [o.model ?? (a.tool ? o.names[a.tool] : ""), a.branch ?? ""].filter(Boolean).join(" · "),
    avatar: o.marks.engine(a.tool ?? ""),
    status,
    words: { idle: a.status === "paused" ? "Paused" : a.status === "offline" ? "Offline" : a.status === "limited" ? "Out of usage" : "Idle", done: "Done", failed: "Stopped" },
    ...(status === "working" ? { current: { key: line, text: clip(line, 80), tool: stepTool(line, o.marks), since } } : {}),
    ...(a.ask ? { ask: { title: a.ask.scope === "commands" ? "Wants to run" : "Wants to go on", command: a.ask.items[0] ?? "a command", tool: stepTool("Ran", o.marks), since, allow: a.ask.scope === "commands" ? "Run it" : "Allow" } } : {}),
    steps,
    ...(a.plan ? { progress: a.plan } : {}),
    ...(a.startedAt ? { started: a.startedAt } : {}),
  };
}

// ── A crew workflow's runs, as a relay ────────────────────────────────────────────────────────────────────────────────────

const RUN_TIME = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Whether a step's crew mate is at it now. */
const atWork = (s: RoomRunStep) => s.status === "claimed" || s.status === "review";

/**
 * A crew workflow's runs as a relay: its crew mates across the top in the order the work passes them (your OK isn't one of them),
 * and between each pair every run that passed from one to the next: what went along (what the step before came to), what was
 * lost (a check that didn't pass and why, a step that stuck), and where it stands now.
 */
export function workflowRelay(runs: RoomRun[], o: { faceOf: (name: string) => ReactNode; roleOf?: (name: string) => string }): Pick<AgentHandoffProps, "agents" | "relays"> {
  const newest = [...runs].sort((a, b) => b.at - a.at);
  const order: string[] = [];
  for (const r of newest.slice().reverse()) for (const s of r.steps) if (s.kind !== "approve" && !order.includes(s.name)) order.push(s.name);
  const latest = newest[0];
  const agents: HandoffAgent[] = order.map((name) => {
    const mineNow = latest?.steps.find((s) => s.name === name && atWork(s));
    const firstStep = latest?.steps.find((s) => s.name === name);
    const waiting = newest.filter((r) => r.status === "running" && r.steps.some((s) => s.name === name && s.status === "pending"));
    return {
      id: name,
      name,
      avatar: o.faceOf(name),
      color: colorOf(name),
      status: mineNow ? "working" : "idle",
      role: o.roleOf?.(name) ?? (firstStep ? sentence(firstStep.title) : ""),
      ...(mineNow ? { now: { title: latest!.name, doing: mineNow.kind === "check" ? "Checking" : "On it" } } : waiting.length ? { next: { title: waiting[0]!.name, more: waiting.length - 1 } } : {}),
    };
  });
  const relays = order.slice(0, -1).map((from, i) => {
    const to = order[i + 1]!;
    const items: HandoffItem[] = [];
    for (const r of newest) {
      const a = r.steps.filter((s) => s.name === from && s.kind !== "approve").at(-1);
      const b = r.steps.find((s) => s.name === to && s.kind !== "approve");
      if (!a || !b || a.status !== "done") continue;
      const lost: HandoffItem["lost"] = [];
      if (b.kind === "check" && b.verdict && !b.verdict.pass) lost.push({ label: "Didn't pass the check", why: b.verdict.why || "Its check didn't say why." });
      if (b.status === "blocked") lost.push({ label: "Stuck", why: b.said ?? `${to} couldn't go on with it.` });
      if ((r.status === "failed" || r.status === "stopped") && r.note && !lost.length && b.status !== "done") lost.push({ label: r.status === "failed" ? "Didn't finish" : "Stopped", why: r.note });
      const carried = [...(a.said ? [{ label: a.said, kind: "note" as const }] : []), { label: sentence(a.title), kind: "file" as const }];
      const state: HandoffItem["state"] =
        atWork(b) ? { kind: "with", text: `With ${to}` }
        : b.status === "done" ? (b.kind === "check" ? (b.verdict?.pass === false ? { kind: "back", text: "Sent back" } : { kind: "good", text: "Passed" }) : { kind: "good", text: "Looks good" })
        : b.status === "blocked" ? { kind: "stuck", text: "Stuck" }
        : b.status === "cancelled" ? { kind: "stuck", text: "Stopped" }
        : { kind: "next", text: `Up next for ${to}` };
      items.push({ id: r.run, title: `${r.trigger === "Run now" ? "Run now" : sentence(r.trigger)} · ${RUN_TIME(r.at)}`, summary: a.said ?? sentence(a.title), state, carried, lost });
    }
    return { from, to, items };
  });
  return { agents, relays };
}
