// The Captain page's pictures (CaptainPage.tsx; Arun, 2026-11-27: Agent Tree, Diff Timeline, Agent Recap and the Cost Waterfall
// "in the captains pages"), each fed from the Captain's record and, for the changes and the cost, its threads' logs (/api/edits).
// Loaded with the page's tabs, so nothing here weighs on the first screen.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentState, crewCounts, drag, keepSize, sizeAt, unappliedOf } from "../../CaptainChat.js";
import { modelWords, turnUsd, type FallTurn } from "../../../cost-fall.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool } from "../../../types.js";
import { api } from "../../api.js";
import { EngineMark } from "../../BrandMarks.js";
import { Icon } from "../../icons.js";
import { CaptainFall } from "../../CostWaterfall.js";
import { askShort, clockOf, forYouOf, type ManagersApi, type ManagerView } from "../../Managers.js";
import type { Identity } from "../../storage.js";
import { BlobFace } from "../../teammate-face.js";
import { AgentRecap, type RecapEvent } from "./AgentRecap.js";
import { AgentTree, type TreeAgent } from "./AgentTree.js";
import { DiffTimeline, type DiffEdit } from "./DiffTimeline.js";
import { useTick } from "./viz-parts.js";

// Plain words for a card: the Captain's markdown (backticks, bold, headings, links) left out, then cut to fit.
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
const clip = (s0: string, n: number) => ((s) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s))(plain(s0));


/* ── Agents: the Captain over its threads ─────────────────────────────────────────────────────────────────────────────────── */

type V2Agent = { id: string; name: string; role: string; look: string; tool: EngineTool; model?: string; status: "idle" | "working" | "needs" | "done" | "failed"; task?: string; sid?: string; lane?: string; state?: "running" | "waiting" | "idle" | "errored" | "stopped" | "gone"; since?: number; activity?: string; usd?: number };
type V2Task = { id: string; text: string; role: string; status: string; agent?: string; started?: number; ended?: number; result?: string; title?: string; copy?: boolean; applied?: boolean; skipped?: boolean };
type V2Plan = { id: string; at: number; status: string; tasks: V2Task[]; goal?: string; final?: { status: string }; revising?: unknown; hold?: unknown };
// A model as its menu names it; a raw id the tool reported ("claude-sonnet-5-5") made readable ("Sonnet 5.5"), never "Claude-s…".
const modelWord = (tool: EngineTool, model?: string) => {
  const info = model ? ENGINE_MODEL_INFO[tool]?.find((x) => x.id === model) : undefined;
  return info?.label ?? (model ? modelWords(model) || model : ENGINE_NAMES[tool]);
};
/** What the page shows for an agent, from its lane's live run over its stored status, as the chat's header and plan card read it. */
const statusOf = (x: V2Agent): TreeAgent["status"] => agentState(x);
/** Its role as the card's subtitle (Arun, 2026-11-28: specialists, "Ada · Security engineer" on the card): on its own line, as the
 *  model line beside the state chip had no room for both. An old "Coder 2" is already its role, so none. */
const roleOf = (x: V2Agent) => (x.role && !x.name.startsWith(x.role) ? { role: x.role } : {});
/**
 * Which plans the crew shows: every running one (a newer draft waiting for its Start used to take the tree over, the working crew
 * gone from it), else the newest; and the newest draft, whose roles show as cards waiting for the Start.
 */
function plansOf(m: ManagerView) {
  const v = m as ManagerView & { plans?: V2Plan[] };
  const plans = [...(v.plans ?? [])].sort((a, b) => b.at - a.at);
  const running = plans.filter((p) => p.status === "running");
  const shown = running.length ? running : plans.filter((p) => p.status !== "draft").slice(0, 1);
  const draft = plans.find((p) => p.status === "draft");
  return { shown, draft, goalOf: (running[0] ?? draft ?? plans[0]) as (V2Plan & { goal?: string }) | undefined };
}
/** The agents the tree shows: the shown plans', and any still working or waiting on you. The bottom panel names the same ones. */
function crewOf(m: ManagerView): V2Agent[] {
  const v = m as ManagerView & { agents?: V2Agent[] };
  const { shown } = plansOf(m);
  return ((v.agents ?? []) as V2Agent[]).filter((x) => !shown.length || shown.some((p) => p.tasks.some((t) => t.agent === x.id)) || x.status === "working" || x.status === "needs" || x.state === "running" || x.state === "waiting");
}

/**
 * Start (or Resume) and Stop at the tree bar's right end (Arun, 2026-11-28: "a start/resume button and stop button ... lined up with
 * the recap"). Start: the plan waiting for its Start. Resume: a running plan held up by failed steps runs them again; a plan you
 * stopped is handed back to the Captain to pick up. Stop: the running plan, asking first what to do with finished work still in its
 * copies, as the plan card's Stop does. Nothing to do: shown, quiet, saying why.
 */
function CrewControls({ m, a }: { m: ManagerView; a: ManagersApi }) {
  const plans = [...((m as ManagerView & { plans?: V2Plan[] }).plans ?? [])].sort((x, y) => y.at - x.at);
  const draft = plans.find((p) => p.status === "draft");
  const run = plans.find((p) => p.status === "running");
  const last = plans[0];
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState("");
  // Resume on a stopped plan asks the Captain once: held off until its new draft or running plan shows (a second press asked twice).
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (draft || run) setResumed(false);
  }, [!!draft, !!run]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctl = useRef<HTMLSpanElement>(null);
  // The Stop window closes on a press outside it or Esc anywhere, as the app's other small windows do.
  useEffect(() => {
    if (!stopping) return;
    const out = (e: PointerEvent) => !ctl.current?.contains(e.target as Node) && setStopping(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && (e.preventDefault(), setStopping(false));
    addEventListener("pointerdown", out, true);
    addEventListener("keydown", esc);
    return () => (removeEventListener("pointerdown", out, true), removeEventListener("keydown", esc));
  }, [stopping]);
  const titleOf = (p: V2Plan) => m.goals?.find((g) => g.id === p.goal)?.title ?? "the plan";
  const go = async (paths: string[], body?: unknown) => {
    setBusy(true);
    setErr("");
    try {
      for (const path of paths) {
        const r = await api<{ error?: string }>(a.identity, `/api/managers/${m.id}${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r?.error) throw new Error(r.error);
      }
    } catch (e) {
      setErr((e as Error).message || "Couldn't reach Friday. Try again in a moment.");
    }
    await a.read();
    setBusy(false);
  };
  const failed = run?.tasks.filter((t) => t.status === "failed") ?? [];
  const going = !!run && (run.tasks.some((t) => t.status === "running" || t.status === "checking" || t.status === "queued") || run.final?.status === "checking" || !!run.revising);
  const unapplied = run ? unappliedOf(run) : [];
  const stopped = !run && !draft && last?.status === "cancelled" && last.tasks.some((t) => t.status !== "done");
  const start: { label: string; title: string; act?: () => void } = !m.on
    ? { label: "Start", title: "The Captain is off. Turn it on in its settings." }
    : draft
      ? { label: "Start", title: `Start ${titleOf(draft)}`, act: () => void go([`/plans/${draft.id}/start`]) }
      : run && failed.length && !going
        ? { label: "Resume", title: `Run the ${failed.length === 1 ? "failed step" : `${failed.length} failed steps`} again`, act: () => void go(failed.map((t) => `/plans/${run.id}/tasks/${t.id}/retry`)) }
        : stopped
          ? resumed
            ? { label: "Resume", title: "Asked the Captain to pick it up" }
            : {
                label: "Resume",
                title: `Have the Captain pick up ${titleOf(last!)} where it stopped`,
                act: () => (
                  setBusy(true),
                  setErr(""),
                  void a
                    .say(m.id, `Carry on with the plan I stopped, "${titleOf(last!)}". Pick up the steps that didn't finish.`)
                    .then((ok) => (ok ? setResumed(true) : setErr("Couldn't ask the Captain to pick it up. Try again in a moment.")))
                    .finally(() => setBusy(false))
                ),
              }
          : run
            ? { label: "Start", title: "The plan is running" }
            : { label: "Start", title: "Nothing waiting to start. Give the Captain a goal in the chat." };
  const stop = (how?: "apply" | "discard") => (setStopping(false), void go([`/plans/${run!.id}/cancel`], how ? { [how]: true } : undefined));
  return (
    <>
      {err && (
        <span className="cpt-ctl-err" role="alert" title={err}>
          {err}
        </span>
      )}
      <span className="cpt-ctl" ref={ctl}>
        <button type="button" className={`cch-btn${start.act ? " primary" : ""}`} disabled={!start.act || busy} onClick={start.act} title={start.title} aria-label={start.label}>
          <Icon name="play" size={12} />
          <span className="cpt-ctl-l">{start.label}</span>
        </button>
        <button
          type="button"
          className="cch-btn"
          disabled={!run || busy}
          aria-expanded={unapplied.length ? stopping : undefined}
          onClick={() => (unapplied.length ? setStopping((s) => !s) : stop())}
          title={run ? `Stop ${titleOf(run)} and its agents` : "Nothing is running"}
          aria-label="Stop"
        >
          <Icon name="stop" size={12} />
          <span className="cpt-ctl-l">Stop</span>
        </button>
        {stopping && run && (
          <div className="cpt-ctl-pop" role="dialog" aria-label="Stop the plan" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setStopping(false))}>
            <div className="cpt-pop-head">
              <span className="cpt-pop-ic">
                <Icon name="stop" size={12} />
              </span>
              <strong>Stop {titleOf(run)}?</strong>
            </div>
            <p className="cpt-pop-text">
              {unapplied.length === 1 ? "One finished step hasn't" : `${unapplied.length} finished steps haven't`} come into your folder yet.
            </p>
            <ul className="cpt-pop-list">
              {unapplied.slice(0, 4).map((t) => {
                const who = (m.agents ?? []).find((x) => x.id === (t as { agent?: string }).agent);
                const words = (t as { title?: string; text?: string }).title ?? (t as { text?: string }).text ?? "A step";
                return (
                  <li key={(t as { id?: string }).id ?? words}>
                    <Icon name="check" size={12} />
                    <span>{words}</span>
                    {who && <em>{who.name}</em>}
                  </li>
                );
              })}
              {unapplied.length > 4 && <li className="more">and {unapplied.length - 4} more</li>}
            </ul>
            <button type="button" className="cch-btn primary cpt-pop-main" autoFocus onClick={() => stop("apply")}>
              Bring {unapplied.length === 1 ? "it" : "them"} in and stop
            </button>
            <div className="cpt-pop-row">
              <button type="button" className="cch-btn cpt-pop-danger" onClick={() => stop("discard")}>
                Stop and throw away
              </button>
              <button type="button" className="cch-btn" onClick={() => setStopping(false)}>
                Keep going
              </button>
            </div>
          </div>
        )}
      </span>
    </>
  );
}

/** The Captain on top (its face, its coding tool and model), and the agents it made for its plans under it, each with its own face. */
export function CaptainTree({ identity, m, a, open, onRecap, selected = null, onSelect, onClear, onLater }: { identity: Identity; m: ManagerView; a: ManagersApi; open: (sid: string) => void; onRecap: () => void; selected?: string | null; onSelect?: (id: string, how: "pick" | "move") => void; onClear?: () => void; /** Puts the Captain's question away (the tree's "Later"). */ onLater?: (at: number) => void }) {
  const now = useTick(true, 1000);
  // The Captain's own cost read from its lane's turns, as the Cost panel prices them, so the tree's total and the panel's agree (its
  // day's spend on the record priced a stepped-up turn at its everyday model: $0.10 here against $0.16 there).
  const logs = useAgentLogs(identity, m);
  const ownUsd = logs ? logs.filter((t) => (t as EditsThread & { captain?: boolean }).captain || t.lane === "main").reduce((n, t) => n + t.turns.reduce((k, x) => k + (turnUsd(x) ?? 0), 0), 0) : null;
  const counts = crewCounts(m);
  const root = useMemo<TreeAgent>(() => {
    const v = m as ManagerView & { agents?: V2Agent[]; plans?: V2Plan[] };
    const { shown, draft, goalOf: live } = plansOf(m);
    const taskOf = new Map((v.plans ?? []).flatMap((p) => p.tasks.map((t) => [t.id, t] as const)));
    // The page reads the live fields the server adds on each read (Contract v1 as built), so its own view of an agent.
    const agents = crewOf(m);
    const children: TreeAgent[] = agents.map((x) => {
      const t = x.task ? taskOf.get(x.task) : undefined;
      return {
        id: x.id,
        name: x.name,
        // Working: what it is at now; done: what it came to; else its task.
        task: clip((x.state === "running" && x.activity) || t?.result || t?.text || x.role, 140),
        ...(x.usd ? { cost: x.usd } : {}),
        model: modelWord(x.tool, x.model),
        ...roleOf(x),
        modelMark: <EngineMark tool={x.tool} size={11} />,
        avatar: <BlobFace seed={x.look} size={18} hat />,
        status: statusOf(x),
        ...(t?.started ? { started: t.started } : x.since ? { started: x.since } : {}),
        ...(t?.ended ? { ended: t.ended } : {}),
      };
    });
    // The plan's tasks no agent has taken yet, by the role that will.
    // Not taken and not queued any more (it failed to start, or was held up or cancelled): it says so, not "Queued".
    // One whose agent isn't on the record (yet, or any more) shows by its role too, running if it runs, not "Queued".
    const ids = new Set((v.agents ?? []).map((x) => x.id));
    for (const t of shown.flatMap((p) => p.tasks)) if ((!t.agent || !ids.has(t.agent)) && t.status !== "done") children.push({ id: t.id, name: t.role, task: clip(t.status === "failed" || t.status === "blocked" ? (t.result ?? t.text) : t.text, 140), status: t.status === "failed" ? "failed" : t.status === "blocked" ? "stopped" : t.status === "running" || t.status === "checking" ? "running" : "queued", ...(t.started ? { started: t.started } : {}) });
    // A draft waiting for its Start: its roles, quiet, saying so.
    for (const t of draft?.tasks ?? []) children.push({ id: `draft:${t.id}`, name: t.role, task: clip(`Waiting for your Start: ${t.text}`, 140), status: "queued" });
    const asks = forYouOf(m);
    // Its own words only: an agent's "started" or update line is the crew's chatter, not what the Captain is at.
    const last = m.log.filter((a) => !["woke", "skipped", "started", "update"].includes(a.kind)).sort((a, b) => b.at - a.at)[0];
    const working = children.some((c) => c.status === "running");
    const busy = working || shown.some((p) => p.status === "running" && (p.final?.status === "checking" || !!p.revising || p.tasks.some((t) => t.status === "queued" || t.status === "checking")));
    // "Done" only for a plan it finished; stopped for one you stopped; else at rest, "Ready" (it said "Done" with nothing done).
    const rest = !m.on ? "stopped" : shown[0]?.status === "done" ? "done" : shown[0]?.status === "cancelled" ? "stopped" : "queued";
    return {
      id: m.id,
      name: "Captain",
      // What its latest turn ran on (a step-up shows), else its everyday model.
      model: modelWord(m.tool as EngineTool, (m as ManagerView & { now?: { model?: string } }).now?.model ?? m.model),
      modelMark: <EngineMark tool={m.tool as EngineTool} size={11} />,
      avatar: <BlobFace seed={m.look} size={18} hat />,
      task: clip((live && live.status !== "done" ? m.goals?.find((g) => g.id === (live as { goal?: string }).goal)?.title : undefined) ?? last?.text ?? (m.on ? "Ready for work" : "Off"), 140),
      // Checking the whole or rewriting the plan is the Captain at work, not "Done" (Arun, 2026-11-28: "status is wrong").
      status: asks.length ? "waiting" : busy ? "running" : rest,
      ...(!asks.length && !busy && rest === "queued" && m.on ? { word: "Ready" } : {}),
      // The plan was stopped, not the Captain: it's on and ready for the next (2026-11-28, the card said Stopped beside ready work).
      ...(!asks.length && !busy && rest === "stopped" && m.on ? { word: "Plan stopped" } : {}),
      ...(asks.length ? { ask: asks[0]!.text } : {}),
      // Only its own lanes' turns: the day's whole spend (every Captain and thread) isn't this card's cost.
      ...(ownUsd != null && logs?.length ? { cost: ownUsd } : {}),
      children,
    };
  }, [m, ownUsd, logs?.length]);
  const recap = (
    <button type="button" className="cch-btn" onClick={onRecap} title="What needs you, what failed and what's done">
      <Icon name="list" size={14} />
      Recap
    </button>
  );
  if (!root.children?.length)
    return (
      <>
        <div className="cpt-tree-bar">
          {recap}
          <span className="viz-tree-trail">
            <CrewControls m={m} a={a} />
          </span>
        </div>
        {/* No crew yet: its shape, ghosted under the Captain, so it's clear what will grow here (Arun, 2026-11-27: empty states). */}
        <div className="cpt-ghost" role="status">
          <div className="cpt-ghost-lead">
            <BlobFace seed={m.look} size={18} hat />
            <span className="cpt-ghost-who">
              <b>Captain</b>
              <span>
                <EngineMark tool={m.tool as EngineTool} size={11} />
                {modelWord(m.tool as EngineTool, m.model)}
              </span>
            </span>
          </div>
          {/* Drawn to the row under it (three 120px cards 8 apart: 376 wide, centres at 60, 188 and 316), so each line lands on its
              card's middle; stretched from 300 wide, the outer two landed 28px inside theirs. */}
          <svg className="cpt-ghost-lines" viewBox="0 0 376 40" aria-hidden>
            <path d="M188 0V16M60 40V24a8 8 0 0 1 8-8h240a8 8 0 0 1 8 8v16M188 16v24" />
          </svg>
          <div className="cpt-ghost-row" aria-hidden>
            {["Researcher", "Coder", "Tester"].map((r) => (
              <div key={r} className="cpt-ghost-card">
                <i />
                <span>{r}</span>
                <em />
                <em className="short" />
              </div>
            ))}
          </div>
          <p className="cpt-ghost-t">Its crew shows up here</p>
          <p className="cpt-ghost-s">Give the Captain a goal in the chat. Each agent it puts on the work gets a card, live as it goes.</p>
        </div>
      </>
    );
  return (
    <AgentTree
      root={root}
      title={`${m.project.name}'s crew`}
      // Recap where the bar's title was (Arun, 2026-11-27: "get rid of this and add the recap button here").
      lead={recap}
      trail={<CrewControls m={m} a={a} />}
      // Counted as the chat's header and plan card count: the Captain and its real agents (not steps waiting for one), every question.
      counts={{ agents: 1 + crewOf(m).length, running: counts.running, waiting: counts.needs }}
      now={now}
      selected={selected}
      {...(onSelect ? { onSelect: (a: TreeAgent, how: "pick" | "move") => onSelect(a.id, how) } : {})}
      {...(onClear ? { onClear } : {})}
      // The Captain's question: put away for later; an agent's: answered where questions are, the chat's needs card.
      answersFor={(a) => (a.id === m.id ? [{ answer: "dismiss", label: "Later" }, { answer: "approve", label: "Answer in chat" }] : [{ answer: "approve", label: "Answer in chat" }])}
      onResolve={(a, answer) => {
        const ask = forYouOf(m)[0];
        if (a.id === m.id && answer === "dismiss" && ask) return onLater?.(ask.at);
        const go = () => {
          const target = document.querySelector<HTMLElement>(".cch-needs .cch-btn.primary, .cch-needs button, .cch-needs input");
          target?.scrollIntoView({ block: "nearest" });
          target?.focus();
          return !!target;
        };
        // The chat closed: opened first (CaptainPage), then its needs card.
        if (!go()) (window.dispatchEvent(new CustomEvent("friday:captain-chat", { detail: "open" })), setTimeout(go, 120));
      }}
    />
  );
}

/* ── Changes and Cost: read from the threads' logs ────────────────────────────────────────────────────────────────────────── */

interface EditsThread {
  sid: string;
  lane?: string;
  title: string;
  start: number | null;
  edits: DiffEdit[];
  turns: FallTurn[];
}

/** The Captain's agents' edits and turns, a lane of its own session each, read again every 10 seconds while the page shows them. */
/** One read for every part of the page that asks within a few seconds (the tree's Captain cost and the bottom panel). */
const editsReads = new Map<string, { at: number; p: Promise<{ threads: EditsThread[] }> }>();
function editsRead(identity: Identity, sid: string, folder: string) {
  const k = `${sid}|${folder}`;
  const had = editsReads.get(k);
  if (had && Date.now() - had.at < 3000) return had.p;
  const p = api<{ threads: EditsThread[] }>(identity, "/api/edits", { method: "POST", body: JSON.stringify({ sids: [sid], folder, split: true }) });
  editsReads.set(k, { at: Date.now(), p });
  p.catch(() => editsReads.delete(k));
  return p;
}
function useAgentLogs(identity: Identity, m: ManagerView) {
  const sid = m.sid;
  const [list, setList] = useState<EditsThread[] | null>(null);
  useEffect(() => {
    if (!sid) return setList([]);
    let off = false;
    const read = () =>
      editsRead(identity, sid, m.project.folder)
        .then((r) => !off && setList(r.threads))
        .catch(() => !off && setList((t) => t ?? []));
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 10_000);
    return () => ((off = true), clearInterval(t));
  }, [identity, sid, m.project.folder]);
  return list;
}
const agentsOf = (m: ManagerView) => ((m as ManagerView & { agents?: V2Agent[] }).agents ?? []);
const agentAt = (m: ManagerView, lane?: string) => agentsOf(m).filter((x) => x.lane === lane).at(-1);

export function CaptainChanges({ identity, m, fill = true }: { identity: Identity; m: ManagerView; fill?: boolean }) {
  return <ChangesView m={m} list={useAgentLogs(identity, m)} fill={fill} sel={null} onPick={() => {}} />;
}

/** Who a lane is: the Captain's own (main), or the agent working in it. */
const laneWho = (m: ManagerView, t: EditsThread) => {
  if ((t as EditsThread & { captain?: boolean }).captain || t.lane === "main") return { id: m.id, name: "Captain", look: m.look, tool: m.tool as EngineTool, model: (m as ManagerView & { now?: { model?: string } }).now?.model ?? m.model };
  const ag = agentAt(m, t.lane);
  return ag ? { id: ag.id, name: ag.name, look: ag.look, tool: ag.tool, model: ag.model } : { id: `${t.sid}:${t.lane}`, name: t.title || "An agent", look: `${t.sid}:${t.lane}`, tool: undefined, model: undefined };
};
/** The lane a selection reads: the Captain's main lane, or the agent's. */
const laneOf = (m: ManagerView, list: EditsThread[] | null, sel: string | null) => (sel ? (list ?? []).find((t) => laneWho(m, t).id === sel) ?? null : null);

const ZERO_CHANGES = (
  <svg className="cpt-zero-art" viewBox="0 0 240 72" aria-hidden>
    <path className="grid" d="M0 12H240M0 36H240M0 60H240" />
    <path className="base" d="M0 66H240" />
    <path className="add" d="M0 66H70l10-10h40l8-14h44l10-8h68" />
    <path className="del" d="M0 66H96l8-4h70l10-3h56" />
  </svg>
);

/**
 * Changes (Arun, 2026-11-27: "the bottom panels ... logic and everything is completely off"): the whole crew, a row an agent with
 * what it touched and when, a press on one picks it; one agent, its Diff Timeline filling the panel. An empty state only when no lane
 * has an edit (it said "No changes yet" under a "+12" bar).
 */
function ChangesView({ m, list, fill, sel, onPick, together = false }: { m: ManagerView; list: EditsThread[] | null; fill: boolean; sel: string | null; onPick: (id: string) => void; /** The whole crew's work as one timeline, not a row an agent (Arun, 2026-11-28). */ together?: boolean }) {
  const now = useTick(true, 1000);
  // Every agent's edits on one clock, from the first lane's start, each marked with who made it. Kept between ticks so an open
  // or pinned edit stays the same one.
  const crewEdits = useMemo(() => {
    const lanes = (list ?? []).filter((t) => t.edits.length);
    if (!lanes.length) return null;
    const t0 = Math.min(...lanes.map((t) => t.start ?? Date.now()));
    const edits = lanes
      .flatMap((t) => {
        const off = t.start != null ? (t.start - t0) / 1000 : 0;
        const by = laneWho(m, t).name;
        return t.edits.map((e) => ({ ...e, at: Math.round(e.at + off), by }));
      })
      .sort((a, b) => a.at - b.at);
    const live = lanes.some((t) => {
      const ag = agentAt(m, t.lane);
      return !!ag && statusOf(ag) === "running";
    });
    return { t0, edits, live, n: lanes.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, (m as ManagerView & { agents?: V2Agent[] }).agents]);
  if (!list) return <p className="viz-empty" role="status">Reading the agents' work…</p>;
  const edited = list.filter((t) => t.edits.length);
  if (sel) {
    const t = laneOf(m, list, sel);
    const w = t ? laneWho(m, t) : (crewOf(m).find((x) => x.id === sel) ?? { name: "Captain" });
    if (!t || !t.edits.length)
      return (
        <div className="cpt-zero" role="status">
          {ZERO_CHANGES}
          <p className="cpt-zero-t">No changes from {w.name} yet</p>
          <p className="cpt-zero-s">Its edits chart here as it makes them: lines in and out, file by file.</p>
        </div>
      );
    const ag = agentAt(m, t.lane);
    // Live as the tree reads it: its lane running now, not its stored status.
    const working = !!ag && statusOf(ag) === "running";
    const who = laneWho(m, t);
    const start = t.start ?? Date.now() - (t.edits.at(-1)?.at ?? 0) * 1000;
    return (
      <DiffTimeline
        key={`${t.sid}:${t.lane}`}
        className="crew-dtl"
        agent={{ id: who.look, name: who.name }}
        {...(who.tool ? { context: `${ENGINE_NAMES[who.tool]}${who.model ? ` · ${modelWord(who.tool, who.model)}` : ""}` } : {})}
        edits={t.edits}
        live={working}
        startedAt={start}
        {...(m.project.folder ? { root: m.project.folder } : {})}
        fill={fill}
        {...(working ? { elapsed: Math.max(t.edits.at(-1)!.at, Math.round((now - start) / 1000)) } : {})}
      />
    );
  }
  if (!edited.length)
    return (
      <div className="cpt-zero" role="status">
        {ZERO_CHANGES}
        <p className="cpt-zero-t">No changes yet</p>
        <p className="cpt-zero-s">Each agent's edits chart here as it makes them: lines in and out, file by file.</p>
      </div>
    );
  if (together && crewEdits)
    return (
      <DiffTimeline
        className="crew-dtl"
        agent={{ id: m.look, name: "The whole crew" }}
        context={crewEdits.n === 1 ? "1 agent's work" : `${crewEdits.n} agents' work as one`}
        edits={crewEdits.edits}
        live={crewEdits.live}
        startedAt={crewEdits.t0}
        {...(m.project.folder ? { root: m.project.folder } : {})}
        fill={fill}
        {...(crewEdits.live ? { elapsed: Math.max(crewEdits.edits.at(-1)!.at, Math.round((now - crewEdits.t0) / 1000)) } : {})}
      />
    );
  const rows = edited
    .map((t) => {
      const who = laneWho(m, t);
      const added = t.edits.reduce((n, e) => n + e.added, 0);
      const removed = t.edits.reduce((n, e) => n + e.removed, 0);
      const last = t.start != null ? t.start + (t.edits.at(-1)?.at ?? 0) * 1000 : null;
      return { t, who, added, removed, files: new Set(t.edits.map((e) => e.file)).size, last };
    })
    .sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const most = Math.max(1, ...rows.map((r) => r.added + r.removed));
  return (
    <ul className="crew-rows" aria-label="Changes by agent">
      {rows.map((r) => (
        <li key={`${r.t.sid}:${r.t.lane}`}>
          <button type="button" className="crew-row" onClick={() => onPick(r.who.id)} aria-label={`${r.who.name}: ${r.files} file${r.files === 1 ? "" : "s"}, +${r.added} −${r.removed}. Show its changes`}>
            <span className="crew-row-face" aria-hidden>
              <BlobFace seed={r.who.look} size={18} hat />
            </span>
            <span className="crew-row-who">
              <b>{r.who.name}</b>
              {r.who.tool && (
                <span>
                  <EngineMark tool={r.who.tool} size={11} />
                  {modelWord(r.who.tool, r.who.model)}
                </span>
              )}
            </span>
            <span className="crew-row-files">
              {r.files} file{r.files === 1 ? "" : "s"}
            </span>
            <span className="crew-row-n">
              <b className="add">+{r.added.toLocaleString()}</b> <b className="del">−{r.removed.toLocaleString()}</b>
            </span>
            <span className="crew-row-bar" aria-hidden>
              <i className="add" style={{ width: `${(r.added / most) * 100}%` }} />
              <i className="del" style={{ width: `${(r.removed / most) * 100}%` }} />
            </span>
            <span className="crew-row-at">{r.last ? clockOf(r.last) : ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CaptainCost({ identity, m }: { identity: Identity; m: ManagerView; open?: (sid: string) => void }) {
  return <CostView m={m} list={useAgentLogs(identity, m)} sel={null} />;
}

/** Cost: the waterfall filling the panel, one scroll under its own header; with an agent picked, its group open and marked, the rest folded. */
function CostView({ m, list, sel }: { m: ManagerView; list: EditsThread[] | null; sel: string | null }) {
  if (!list) return <p className="viz-empty" role="status">Reading the agents' work…</p>;
  const rows = list
    .filter((t) => t.turns.length)
    .map((t) => {
      const who = laneWho(m, t);
      return { sid: `${t.sid}:${t.lane}`, title: who.name, ...(who.tool ? { tool: who.tool } : {}), turns: t.turns };
    });
  if (!rows.length)
    return (
      <div className="cpt-zero" role="status">
        <svg className="cpt-zero-art" viewBox="0 0 240 72" aria-hidden>
          <rect className="bar" x="8" y="10" width="70" height="12" rx="3" />
          <rect className="bar" x="78" y="30" width="96" height="12" rx="3" />
          <rect className="bar" x="174" y="50" width="56" height="12" rx="3" />
        </svg>
        <p className="cpt-zero-t">$0.00 so far</p>
        <p className="cpt-zero-s">Each turn the Captain and its crew take lands here, by agent, with its tokens and what it cost.</p>
      </div>
    );
  const t = laneOf(m, list, sel);
  return <CaptainFall project={m.project.name} threads={rows} panel {...(t ? { focus: `${t.sid}:${t.lane}` } : {})} />;
}

/* ── The crew's panel: changes and cost, rising from the foot of the crew ─────────────────────────────────────────────────── */

/**
 * The bar: Changes and Cost, the crew to pick from (All, the Captain, each agent), the crew's totals over every lane (the Captain's
 * own turns too, as the tree's total), and the chevron. A tab opens the panel or switches it, never closes it; the chevron and the
 * band's icon open and close it; Esc in it clears a pick, then closes it. Open, about 40% of the page, dragged by its top edge and
 * kept (Arun, 2026-11-27: "the bottom panels and stuff are like UX flawed like logic and everything is completely off").
 */
export function CrewPanel({ identity, m, open, setOpen, sel, setSel, view, setView }: { identity: Identity; m: ManagerView; open: boolean; setOpen: (o: boolean) => void; sel: string | null; setSel: (id: string | null) => void; /** Changes or Cost, kept by the page so the chat's "Review changes" can open Changes. */ view: "changes" | "cost"; setView: (v: "changes" | "cost") => void }) {
  const list = useAgentLogs(identity, m);
  // Changes with no one picked: everyone's work as one timeline (Together), or a row an agent (By agent). Kept for next time.
  const [together, setTogether] = useState(() => {
    try {
      return localStorage.getItem("friday.captain.changesBy") !== "agent";
    } catch {
      return true;
    }
  });
  const keepTogether = (v: boolean) => {
    setTogether(v);
    try {
      localStorage.setItem("friday.captain.changesBy", v ? "together" : "agent");
    } catch {
      /* not kept */
    }
  };
  const added = (list ?? []).reduce((n, t) => n + t.edits.reduce((k, e) => k + e.added, 0), 0);
  const removed = (list ?? []).reduce((n, t) => n + t.edits.reduce((k, e) => k + e.removed, 0), 0);
  const usd = (list ?? []).reduce((n, t) => n + t.turns.reduce((k, x) => k + (turnUsd(x) ?? 0), 0), 0);
  const box = useRef<HTMLElement>(null);
  // The pane's height, measured again as the window or the pane resizes, so the panel never stands taller than it.
  const [pageH, setPageH] = useState(800);
  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const fit = () => setPageH(el.clientHeight || 800);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const page = () => pageH;
  const most = () => Math.max(200, page() - 120);
  const [height, setHeight] = useState<number | null>(() => {
    const v = sizeAt("friday.captain.panelH", 0, 200, 4000);
    return v || null;
  });
  const h = Math.max(200, Math.min(most(), height ?? Math.round(page() * 0.4)));
  const dragH = (e: React.PointerEvent) => drag(e, "y", h, (v) => setHeight(Math.max(200, Math.min(most(), v))), (v) => keepSize("friday.captain.panelH", Math.max(200, Math.min(most(), v))));
  const pick = (v: "changes" | "cost") => (setView(v), setOpen(true));
  const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
  const crew = [{ id: m.id, name: "Captain", look: m.look }, ...crewOf(m).map((x) => ({ id: x.id, name: x.name, look: x.look }))];
  const picked = sel ? crew.find((x) => x.id === sel) : undefined;
  return (
    <section
      ref={box}
      className={`crew-panel${open ? " open" : ""}`}
      aria-label="The crew's changes and cost"
      style={open ? { height: h } : undefined}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.stopPropagation();
        if (sel) setSel(null);
        else setOpen(false);
      }}
    >
      {open && <div className="crew-resize" role="separator" aria-orientation="horizontal" aria-label="Drag to resize the panel" onPointerDown={dragH} />}
      <div className="crew-bar">
        <div className="crew-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={open && view === "changes"} className="crew-tab" onClick={() => pick("changes")}>
            Changes
            {(added > 0 || removed > 0) && (
              <span className="crew-n">
                <b className="add">+{short(added)}</b> <b className="del">−{short(removed)}</b>
              </span>
            )}
          </button>
          <button type="button" role="tab" aria-selected={open && view === "cost"} className="crew-tab" onClick={() => pick("cost")}>
            Cost
            {usd > 0 && <span className="crew-n">{usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`}</span>}
          </button>
        </div>
        {/* No strip of every agent (Arun, 2026-11-28: "get rid of this"): an agent is picked on the tree or in Changes, and the one
            picked shows here with a way back to everyone's. */}
        <div className="crew-who">
          {open && view === "changes" && !picked && (added > 0 || removed > 0) && (
            <div className="crew-seg" role="radiogroup" aria-label="Show changes">
              <button type="button" role="radio" aria-checked={together} className={`crew-chip${together ? " on" : ""}`} onClick={() => keepTogether(true)}>
                Together
              </button>
              <button type="button" role="radio" aria-checked={!together} className={`crew-chip${!together ? " on" : ""}`} onClick={() => keepTogether(false)}>
                By agent
              </button>
            </div>
          )}
          {picked && (
            <button type="button" className="crew-chip on" onClick={() => setSel(null)} aria-label={`Showing ${picked.name}'s work. Show everyone's`} title="Show everyone's">
              <span className="crew-chip-face" aria-hidden>
                <BlobFace seed={picked.look} size={14} hat />
              </span>
              {picked.name}
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        {/* "Open its lane" waits for App to open the Captain's hidden session at a lane (it isn't in recents and has no invite):
            a button that did nothing is worse than none (2026-11-28, before the release). */}
        <button type="button" className="crew-fold" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Fold the panel" : "Open the panel"}>
          <svg className="fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 7.5 6 4.5l3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open && (
        <div className={`crew-body${view === "cost" || sel || (together && (added > 0 || removed > 0)) ? " flush" : ""}`}>
          {view === "changes" ? <ChangesView m={m} list={list} fill sel={sel} onPick={(id) => setSel(id)} together={together} /> : <CostView m={m} list={list} sel={sel} />}
        </div>
      )}
    </section>
  );
}

/* ── Recap: what needs you, what failed, what's done ──────────────────────────────────────────────────────────────────────── */

export function CaptainRecap({ m, api: a, open, close }: { m: ManagerView; api: ManagersApi; open: (sid: string) => void; /** Closes the dialog (Review goes to the chat). */ close?: () => void }) {
  // While you were away, when you were; else today since midnight.
  const away = m.away && m.away.since ? m.away : null;
  const since = away ? away.since : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const events = useMemo<RecapEvent[]>(() => {
    const out: RecapEvent[] = [];
    const v2 = m as ManagerView & { agents?: V2Agent[]; plans?: V2Plan[] };
    const agentOf = (id?: string) => (id ? (v2.agents ?? []).find((x) => x.id === id) : undefined);
    const area = (text: string) => (text.includes(":") && text.split(":")[0]!.length <= 60 ? text.split(":")[0]!.trim() : clip(text, 60));
    const who = (t: V2Task) => ((ag) => ({ title: `${ag?.name ?? t.role} · ${area(t.text)}`, ...(ag ? { logo: <BlobFace seed={ag.look} size={16} hat /> } : {}) }))(agentOf(t.agent));
    // What needs you: its questions (Review goes to the answer in the chat; Dismiss puts it away unanswered), and go-aheads.
    for (const x of forYouOf(m)) out.push({ id: `ask:${x.at}`, kind: "needs", at: x.at, title: askShort(x.text), detail: "Your Captain asks", action: "Dismiss", doneLabel: "Dismissed", undo: false });
    for (const t of m.threads ?? [])
      if (t.state === "needs") out.push({ id: `ok:${t.sid}`, kind: "needs", at: t.since, title: t.title || "A thread", detail: t.ask ? `Wants to run: ${t.ask}` : (t as { question?: string }).question ? `Asks: ${(t as { question?: string }).question}` : "Waiting on your go-ahead", action: "Open", undo: false });
    // Failed and done from the plans themselves, as their cards count them (it read only the old flow's checks, and undercounted).
    const done = new Set<string>();
    for (const p of v2.plans ?? [])
      for (const t of p.tasks) {
        const at = t.ended ?? t.started ?? p.at;
        if (t.status === "failed" && (at >= since || p.status === "running")) out.push({ id: `task:${p.id}:${t.id}`, kind: "failed", at, ...who(t), detail: clip(t.result ?? "It stopped on an error", 160), action: "Retry", undo: false });
        if (t.status === "done" && at >= since) {
          out.push({ id: `done:${p.id}:${t.id}`, kind: "done", at, ...who(t), detail: clip(t.result ?? "Done", 160), undo: false });
          const lane = agentOf(t.agent)?.lane;
          if (lane) done.add(lane);
        }
      }
    for (const x of m.log) if (x.kind === "sent-back" && x.at >= since) out.push({ id: `fail:${x.at}`, kind: "failed", at: x.at, title: clip(x.text, 80), detail: "Its check failed and went back to the thread", action: "Open", undo: false });
    // Ready work the plans don't already show (the old flow's threads).
    for (const r of m.ready ?? []) {
      if (r.at < since || (r.lane && done.has(r.lane))) continue;
      const ag = (v2.agents ?? []).filter((x) => x.lane === r.lane).at(-1);
      out.push({ id: `ready:${r.sid}:${r.lane}`, kind: "done", at: r.at, title: ag ? ag.name : r.title, detail: r.facts, ...(ag ? { logo: <BlobFace seed={ag.look} size={16} hat /> } : {}), undo: false });
    }
    return out.filter((e) => Number(e.at) >= since || e.kind !== "done");
  }, [m, since]);
  return (
    <AgentRecap
      events={events}
      since={Math.min(since, ...events.map((e) => Number(e.at)))}
      title={away ? "While you were away" : "Today"}
      // Opened on a press, it shows what happened at once: no replay of the day drawing across (Arun, 2026-11-27).
      replay={0}
      onAction={(e, what) => {
        const [kind, ...rest] = e.id.split(":");
        if (kind === "ask") {
          // Review: to its answer in the chat's needs card (CaptainChat listens for friday:captain-answer); Dismiss: put away.
          if (what === "review") return void (close?.(), dispatchEvent(new CustomEvent("friday:captain-answer", { detail: { at: Number(rest[0]) } })));
          return what === "primary" ? a.answer(m.id, Number(rest[0]), null) : undefined;
        }
        if (kind === "task" && what === "primary") return api(a.identity, `/api/managers/${m.id}/plans/${rest[0]}/tasks/${rest[1]}/retry`, { method: "POST" }).then(() => a.read());
        const sid = kind === "ok" ? rest[0] : (m.log.find((x) => `fail:${x.at}` === e.id)?.sid ?? null);
        if (sid) open(sid);
      }}
    />
  );
}
