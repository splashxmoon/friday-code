import type { BarState, LiveView } from "./Managers.js";

/**
 * How a Captain v2 stands (Arun, 2026-11-27: "LOOK INTO STATUSES AND STUFF LINKED THE CAPTAINS IN THE SIDE BAR"): from its live
 * fields alone, never the project's threads, which are the person's. Can't start, then what waits on you (questions, agents
 * waiting, a plan for your Start), a failed step, at work (agents, its own turn, a check), ready cards of its own, else its line.
 */
/** Its autonomy in its chat picker's words (CaptainChat AUTONOMY). */
export const MODE: Record<string, string> = { ask: "Ask first", merge: "Ask before bringing in", run: "Run to ready" };
const CLS: Record<string, string> = { working: "work", ready: "ready", failed: "fail" };
export function v2StateOf(x: LiveView, now: number): BarState {
  const b = stateOf2(x, now);
  return { ...b, cls: CLS[b.tone] ?? "" };
}
function stateOf2(x: LiveView, now: number): BarState {
  if (!x.on) return { tone: "off", line: "Open it to turn it on" };
  const n0 = x.now ?? { text: "Idle", working: 0, needs: 0, asks: 0, failed: 0 };
  // Its status line: the server's label once it words one, else its facts line.
  const n = { ...n0, text: n0.label || n0.text };
  const plan = x.plans?.find((p) => p.id === n.plan);
  const pr = plan?.progress;
  const cap = x.captain;
  const turn = cap?.state === "running";
  const crew = (x.agents ?? []).filter((a) => a.task && plan?.tasks.some((t) => t.agent === a.id));
  const busy = crew.find((a) => a.status === "working");
  const needs = n.asks + n.needs + (plan?.status === "draft" ? 1 : 0);
  const working = n.working + (turn ? 1 : 0) || (pr?.checking || plan?.final?.status === "checking" ? 1 : 0);
  const count = { working, needs, crew };
  const at = x.log.find((a) => a.kind === "for-you" && !a.answered && !a.dismissed && now - a.at < 864e5)?.at;
  if (x.stall || cap?.state === "errored") return { ...count, tone: "failed", pill: x.stall ? "Can't start" : "Errored", line: cap?.reason || x.stall?.why || "Its last turn ended on an error" };
  if (needs) return { ...count, tone: "needs", pill: `${needs} needs you`, line: n.text, ...(at ? { at } : {}), ...(n.asks + n.needs ? {} : { act: "Start" }) };
  if (n.failed) return { ...count, tone: "failed", pill: `${n.failed} failed`, line: n.text };
  if (working) {
    const since = busy?.since ?? cap?.since;
    return { ...count, tone: "working", pill: `${working} working`, line: !n.working && turn ? cap?.activity || "Planning" : n.text, prog: pr && plan?.status === "running" ? { done: pr.done, of: pr.total } : null, tool: busy?.tool ?? x.tool, ...(since ? { since } : {}) };
  }
  const ready = (x.ready ?? []).filter((r) => r.sid === x.sid).length;
  const last = x.plans?.[0];
  if (ready) return { ...count, tone: "ready", pill: `${ready} ready`, line: last?.status === "done" ? `All ${last.tasks.length} done, ready for you` : `${ready} ready for you` };
  return { ...count, tone: "quiet", line: n.text };
}
