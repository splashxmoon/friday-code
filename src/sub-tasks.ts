// A session's subagents, read from its log: shared by the client's tray and cards (client/Tasks.tsx subTasksIn) and the server's
// project overview (app.ts /api/overview), which shows each thread's agents with the subagents they sent off.
import { MAIN_LANE, type AgentTaskStatus, type SessionEvent } from "./types.js";

/** A subagent a coding tool started, where it stands now: the latest `agent.task` for it, with its first's description. */
export interface SubTask {
  key: string;
  /** The tool's own id for it (Claude Code's task id; Cursor's and Codex's call id). */
  id: string;
  lane: string;
  by: string;
  description: string;
  agentType?: string;
  background?: boolean;
  status: AgentTaskStatus;
  summary?: string;
  start: number;
  end?: number;
  /** Where in the log it started, so the feed can put it in the run that started it. */
  seq: number;
  /**
   * Seen starting: first reported running, or with what it was asked to do. A coding tool beginning a turn reports on what was left over from its last
   * session, already over ("Background shell command didn't finish before the previous session ended"): those were taken for
   * subagents this run sent off, and a card of them came with every new prompt (Arun, 2026-10-24).
   */
  opened: boolean;
  /** While it works: what it is doing now. */
  doing?: string;
  /** Steps it has taken, the latest count the tool gave. */
  steps?: number;
  /** When the tool last said anything of it: one at work and silent a long while may be stuck. */
  heard: number;
}


/** Every subagent in the log, where it stands now. */
export function subTasksOf(events: SessionEvent[]): SubTask[] {
  const all = new Map<string, SubTask>();
  for (const e of events) {
    // Stopping a turn stops what it sent off, unless it was sent to work on in the background: a subagent no tool reports on again
    // read "2 subagents working" after Stop (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    if (e.body.type === "run.pause" || e.body.type === "run.cancel") {
      const lane = e.lane ?? MAIN_LANE;
      for (const [k, t] of all) if (t.lane === lane && t.status === "running" && !t.background) all.set(k, { ...t, status: "stopped", end: e.ts });
      continue;
    }
    if (e.body.type !== "agent.task") continue;
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    const key = `${lane}:${b.id}`;
    const had = all.get(key);
    all.set(key, {
      key,
      id: b.id,
      lane,
      by: had?.by ?? e.actor.name,
      description: had?.description || b.description || (b.agentType === "command" ? "Background command" : "Subagent"),
      ...((had?.agentType ?? b.agentType) ? { agentType: had?.agentType ?? b.agentType } : {}),
      ...((had?.background ?? b.background) !== undefined ? { background: had?.background ?? b.background } : {}),
      status: b.status,
      ...((b.summary ?? had?.summary) ? { summary: b.summary ?? had?.summary } : {}),
      start: had?.start ?? e.ts,
      seq: had?.seq ?? e.seq,
      // Or said what it was asked to do: a Codex agent that finished between two calls is first reported already over, with its
      // task; a leftover report has none.
      opened: had?.opened ?? (b.status === "running" || !!b.description),
      ...(b.status !== "running" ? { end: e.ts } : {}),
      // What it was doing as it failed stays: it is the nearest thing to a reason when the tool gives none (2026-10-27 audit).
      ...((b.status === "running" || b.status === "error") && (b.doing ?? had?.doing) ? { doing: b.doing ?? had?.doing } : {}),
      heard: e.ts,
      ...((b.steps ?? had?.steps) ? { steps: b.steps ?? had?.steps } : {}),
    });
  }
  return [...all.values()];
}
