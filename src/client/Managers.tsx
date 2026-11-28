import { Suspense, cloneElement, isValidElement, lazy, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { CaptainAgent, Manager, ManagerLevel, ManagerThread, Plan, ReadyItem } from "../managers.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { LiveClock, TabRing, elapsed, useNow } from "./presence.js";
import type { Identity } from "./storage.js";
import { BlobFace } from "./teammate-face.js";
import { Fold } from "./sidebar-fold.js";
import { MANAGER_STARTED } from "./manager-events.js";
import "./managers.css";

/**
 * The project Captains in the coding sidebar (spec 14, sidebar A3; Arun, 2026-11-24: "A3", "i dont want that full ring around the
 * mascot to be the thing just the small ring thing we have for the coding session tabs"): a bar of every Captain's face at the top,
 * each project's Captain on its tile with one line under its name, its panel (what it's doing, how much it may do, its queue, what
 * it did), and the sheet that sets one up. Its live state is the session tab's small ring beside it, never a ring round its face.
 */

/** A Captain as GET /api/managers sends it: with its threads (managers-run threadsOf, aeae2438). */
export type ManagerView = Manager & { threads?: ManagerThread[] };
/** A project as the sidebar knows it: its name, its folder, its threads now. */
export interface ManagedProject {
  name: string;
  folder: string;
  running: number;
  needs: number;
}

export const LEVEL_WORD: Record<ManagerLevel, string> = { watch: "Watch", help: "Help", run: "Run" };
/** Its mode in words: a Captain v2's autonomy, as its chat's picker says it (CaptainChat AUTONOMY), else an older one's level. */
export const modeOf = (m: ManagerView) => (!m.on ? "Off" : m.autonomy ? (v2Mode?.[m.autonomy] ?? "") : LEVEL_WORD[m.level]);
/** A Captain v2 with GET /api/managers's live fields (docs/plans/captain-v2.md, "Contract v1 as built"). */
export type LiveView = Omit<ManagerView, "agents" | "plans"> & {
  agents?: (CaptainAgent & { state?: string; since?: number; activity?: string })[];
  plans?: (Plan & { progress?: { total: number; done: number; checking: number } })[];
  now?: { text: string; /** Its status line, once the server words one. */ label?: string; working: number; needs: number; asks: number; failed: number; plan?: string };
  captain?: { state: string; since?: number; activity?: string; reason?: string };
};
// What each level does (2026-11-25, the advanced Captain): you can talk to it at every level.



const DAY = 24 * 3600_000;



/** A Captain's question in a few words, without the thread's quoted name: "what to try?" for the ones that end on that. */
export const askShort = (q: string) => (/what to try/i.test(q) ? "what to try?" : (q.replace(/"[^"]*"\s*/, "").split(/(?<=[.?!]) /)[0] ?? q));

/** Its "For you" questions from the last day: the person's to decide. */
export const forYouOf = (m: ManagerView, now = Date.now()) => m.log.filter((a) => a.kind === "for-you" && !a.answered && !a.dismissed && now - a.at < DAY);

/** The project a Captain minds, by its folder or its name. */
export function managerFor(managers: readonly ManagerView[], project: { name: string; folder?: string }): ManagerView | null {
  const folder = project.folder?.replace(/[\\/]+$/, "").toLowerCase();
  return managers.find((m) => (folder && m.project.folder.replace(/[\\/]+$/, "").toLowerCase() === folder) || m.project.name.toLowerCase() === project.name.toLowerCase()) ?? null;
}

/** Every Captain, read now and every few seconds while the window is showing, with what changes them. */
export function useManagers(identity: Identity, enabled = true) {
  const [managers, setManagers] = useState<ManagerView[]>([]);
  /** Read once at least: an empty list after that is none, not still loading (the Captain page after its only Captain is removed). */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const seen = useRef<Set<string> | null>(null);
  /** New threads a Captain started since the last read: the session list is told to read them in. */
  const told = (list: readonly ManagerView[]) => {
    const now = new Set(list.flatMap((m) => m.log.filter((a) => a.kind === "started" && a.sid).map((a) => a.sid!)));
    if (seen.current && [...now].some((sid) => !seen.current!.has(sid))) dispatchEvent(new Event(MANAGER_STARTED));
    seen.current = now;
  };
  const read = useCallback(async () => {
    const got = await api<{ managers?: ManagerView[] }>(identity, "/api/managers").catch(() => null);
    if (got?.managers) (await v2Ready(got.managers)?.catch(() => {}), told(got.managers), setManagers(got.managers), setLoaded(true));
  }, [identity]);
  useEffect(() => {
    if (!enabled) return;
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 5_000);
    return () => clearInterval(t);
  }, [read, enabled]);
  const send = useCallback(
    async (path: string, method: string, body?: unknown) => {
      setError("");
      try {
        const got = await api<{ managers?: ManagerView[]; error?: string }>(identity, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (got.error) return (setError(got.error), false);
        if (got.managers) (await v2Ready(got.managers)?.catch(() => {}), told(got.managers), setManagers(got.managers));
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [identity],
  );
  return {
    identity,
    managers,
    loaded,
    error,
    read,
    create: (body: Record<string, unknown>) => send("/api/managers", "POST", body),
    change: (id: string, body: Record<string, unknown>) => send(`/api/managers/${id}`, "PATCH", body),
    remove: (id: string) => send(`/api/managers/${id}`, "DELETE"),
    queue: (id: string, text: string) => send(`/api/managers/${id}/queue`, "POST", { text }),
    unqueue: (id: string, task: string) => send(`/api/managers/${id}/queue/${task}`, "DELETE"),
    /** A thread's ready card put away. */
    doneReady: (id: string, sid: string, lane?: string) => send(`/api/managers/${id}/ready`, "POST", { sid, ...(lane ? { lane } : {}) }),
    /** One of its suggested next steps: onto its queue, or put away. */
    next: (id: string, at: number, take: boolean) => send(`/api/managers/${id}/next`, "POST", { at, take }),
    awaySeen: (id: string) => send(`/api/managers/${id}/away`, "POST", { seen: true }),
    /** On Run, work is a mission (one way in): what done means, if said, and the box's settings go with it. */
    say: (id: string, text: string, opts: { done?: string; parallel?: number; budgetUsd?: number; prs?: boolean } = {}) => send(`/api/managers/${id}/say`, "POST", { text, ...opts }),
    newChat: (id: string) => send(`/api/managers/${id}/chat`, "POST", { new: true }),
    openChat: (id: string, at: number) => send(`/api/managers/${id}/chat`, "POST", { open: at }),
    deleteChat: (id: string, at: number) => send(`/api/managers/${id}/chat`, "POST", { delete: at }),
    giveUp: (id: string, goal: string) => send(`/api/managers/${id}/goals/${goal}`, "DELETE"),
    /** Missions (missions.ts): one started, paused or carried on, its budget changed, or stopped for good. */
    startMission: (id: string, body: { ask: string; done: string; parallel: number; budgetUsd: number; prs: boolean }) => send(`/api/managers/${id}/missions`, "POST", body),
    pauseMission: (id: string, goal: string, pause: boolean) => send(`/api/managers/${id}/missions/${goal}`, "POST", { pause }),
    stopMission: (id: string, goal: string) => send(`/api/managers/${id}/missions/${goal}`, "DELETE"),
    dismissSuggest: (key: string) => send("/api/managers/suggest/dismiss", "POST", { key }),
    answer: (id: string, at: number, text: string | null) => send(`/api/managers/${id}/answer`, "POST", text === null ? { at, dismiss: true } : { at, text }),
  };
}
export type ManagersApi = ReturnType<typeof useManagers>;

/** A Captain's face: the crew's blob, with the cap that marks it as the project's Captain. Asleep when it's off. */
export function ManagerFace({ m, size }: { m: Pick<ManagerView, "look" | "on">; size: number }) {
  return (
    <span className="mgr-face" style={{ width: size, height: size }} aria-hidden>
      <BlobFace seed={m.look} size={size} eyes={m.on ? "open" : "closed"} hat />
    </span>
  );
}

/**
 * Where a thread or a Captain stands, as the polish pass draws it (2026-11-27, "complete UI polish ... go all out"): one status
 * chip, a rounded square. Its own few lines of CSS rather than the kit's Badge, which would load with the first screen (the
 * sidebar is in it; the status icons live in ManagerWindow.tsx, which loads later).
 */
export const StatusChip = ({ tone, children }: { tone?: "working" | "needs" | "ready" | "failed" | undefined; children: ReactNode }) => (
  <span className={`mgr-st${tone ? ` ${tone}` : ""}`}>
    {tone === "working" ? <span className="mgr-st-ring" aria-hidden /> : tone ? <i aria-hidden /> : null}
    {children}
  </span>
);

/** Its live state as a session tab shows one: working while its project runs, waiting when something needs you. */
const ringOf = (m: ManagerView, p: ManagedProject | undefined) => (!m.on ? null : (p?.needs ?? 0) + forYouOf(m).length > 0 ? ("needs" as const) : (p?.running ?? 0) > 0 ? ("working" as const) : null);

/**
 * The Captains at the top of the coding sidebar, as the polish mock drew them (Arun, 2026-11-27: "Captains in the sidebar — you
 * didnt do this properly as the same thing you sent in the artifact...."; his word for this surface over the 11-24 ring call and
 * the timer removals). Open: a card each, its face wearing a progress ring for the thread it's working on, its name and one state
 * chip, that thread whole, then where it is (its tool, the step, a live clock) and a dot per thread; an asking one says when and
 * offers Answer; an off one says how to turn it on. Folded: one line, "Captains" and a running-now chip with the counts, which opens
 * the Running now list. Folded or not is remembered here, open the first time; a row opens its Captain's window. Add is the way in.
 */
const BAR_KEY = "friday.captains.bar";
const readBarOpen = () => {
  try {
    return localStorage.getItem(BAR_KEY) !== "shut";
  } catch {
    return true;
  }
};
type BarTone = "off" | "needs" | "ready" | "working" | "failed" | "quiet";

/**
 * How far a Captain's working thread has got, by the best measure its record has: the parts of the mission or goal it belongs to,
 * done of all. Null when it belongs to none (its ring then turns without a fill).
 */
export function progressOf(x: ManagerView, sid: string | undefined): { done: number; of: number } | null {
  const g = sid ? x.goals?.find((g) => g.threads.some((t) => t.sid === sid)) : undefined;
  if (!g) return null;
  const of = g.threads.length + x.queue.filter((q) => q.goal === g.id).length;
  const done = g.threads.filter((t) => t.state === "ready" || t.state === "shipped").length;
  return of > 1 ? { done, of } : null;
}

/** A progress ring in the live colour on a quiet track, filled to `frac`; without one it turns, a quarter lit. */
export function ProgressRing({ size, frac, className = "" }: { size: number; frac: number | null; className?: string }) {
  const r = size / 2 - 1;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`mgr-pr${frac === null ? " spin" : ""} ${className}`} viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-track)" strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--live)" strokeWidth={2} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (frac === null ? 0.25 : Math.max(0.08, Math.min(1, frac))))} />
    </svg>
  );
}

export type BarState = { tone: BarTone; line: string; pill?: string; since?: number; at?: number; tool?: EngineTool; prog?: { done: number; of: number } | null; working?: number; needs?: number; /** A Captain v2's agents on its live plan. */ crew?: LiveView["agents"]; act?: string; /** Its band chip's class. */ cls?: string };
/** Either flow's state: a Captain v2 by its live fields, an older one by its project's threads as before. */
export const stateOf = (x: ManagerView, p: ManagedProject | undefined, now: number): BarState => (x.autonomy ? (v2StateOf?.(x as LiveView, now) ?? { tone: "quiet", line: "" }) : barStateOf(x, p, now));
// Its own small chunk, read in beside the first GET /api/managers that has one (useManagers waits for both), so it's there before any
// Captain v2 draws and the first screen stays in budget (test/client-bundle.test.ts).
let v2StateOf: ((x: LiveView, now: number) => BarState) | undefined;
let v2Mode: Record<string, string> | undefined;
const v2Ready = (list: readonly ManagerView[]) => (v2StateOf || !list.some((m) => m.autonomy) ? null : import("./captain-state.js").then((x) => void ((v2StateOf = x.v2StateOf), (v2Mode = x.MODE))));
/** How a Captain stands for its row, from its live record and its project's threads now. */
function barStateOf(x: ManagerView, p: ManagedProject | undefined, now: number): BarState {
  if (!x.on) return { tone: "off", line: "Open it to turn it on" };
  const asks = forYouOf(x, now);
  const ts = x.threads ?? [];
  const waiting = ts.filter((t) => t.state === "needs");
  // A question and the thread it's about are one thing waiting on you, not two; counted as the window's header counts them, from
  // its own threads (the project's count only when it sent none).
  const needs = asks.length + (x.threads ? waiting.filter((t) => !asks.some((q) => q.sid === t.sid)).length : (p?.needs ?? 0));
  const working = ts.filter((t) => t.state === "working").sort((a, b) => (a.since || now) - (b.since || now));
  const count = { working: Math.max(working.length, p?.running ?? 0), needs };
  // An asking Captain's line is the thread and the question in short, "Add the refunds email: what to try?", not the whole ask.
  const about = asks[0] && ts.find((t) => t.sid === asks[0]!.sid)?.title;
  if (needs) return { ...count, tone: "needs", line: asks[0] ? (about ? `${about}: ${askShort(asks[0].text)}` : asks[0].text) : waiting[0] ? `${waiting[0].title} needs you` : `${needs} waiting on you`, pill: asks.length ? "Asks" : "Needs you", ...((asks[0]?.at ?? waiting[0]?.since) ? { at: asks[0]?.at ?? waiting[0]!.since } : {}) };
  const ready = x.ready ?? [];
  if (ready.length) {
    const r = ready[0]!;
    const fact = readyFacts(r).split(" · ")[0];
    return { ...count, tone: "ready", line: fact ? `${r.title} · ${fact.charAt(0).toLowerCase()}${fact.slice(1)}` : r.title, pill: "Ready" };
  }
  if (count.working) {
    const w = working[0];
    return { ...count, tone: "working", line: w?.title || "Working", prog: progressOf(x, w?.sid), ...(w?.tool ? { tool: w.tool } : {}), ...(w?.since ? { since: w.since } : {}) };
  }
  if (x.away && !x.away.back && x.away.until > now) return { ...count, tone: "quiet", line: `Away until ${clockOf(x.away.until)}` };
  const idle = ts.filter((t) => t.state === "idle" || t.state === "stopped").length;
  return { ...count, tone: "quiet", line: idle ? `${idle} thread${idle === 1 ? "" : "s"} idle` : x.queue.length ? `${x.queue.length} queued` : "All quiet" };
}
const LazyRunning = lazy(() => import("./ManagerWindow.js").then((x) => ({ default: x.RunningNow })));

export function ManagersBar({ api: m, projects, open, setOpen, onAdd }: { api: ManagersApi; projects: ReadonlyMap<string, ManagedProject>; open: string | null; setOpen: (key: string | null) => void; onAdd: (project?: { name: string; folder: string }) => void }) {
  const [unfolded, setUnfolded] = useState(readBarOpen);
  const [running, setRunning] = useState(false);
  const now = useNow();
  const fold = () =>
    setUnfolded((v) => {
      try {
        localStorage.setItem(BAR_KEY, v ? "shut" : "open");
      } catch {}
      return !v;
    });
  const states = new Map(m.managers.map((x) => [x.id, stateOf(x, projects.get(x.project.name), now)]));
  const st = (x: ManagerView) => states.get(x.id)!;
  // Each trigger its own open state: a row and the Running now list for the same Captain never open two windows.
  const pop = (x: ManagerView, trigger: ReactNode, where = "bar") => (
    <ManagerPopover key={`${where}:${x.id}`} m={x} p={projects.get(x.project.name)} api={m} open={open === `${where}:${x.id}`} onOpenChange={(v) => setOpen(v ? `${where}:${x.id}` : null)}>
      {trigger}
    </ManagerPopover>
  );
  const row = (x: ManagerView) => {
    const b = st(x);
    const ts = x.threads ?? [];
    return pop(
      x,
      <button type="button" className={`mgr-crow ${b.tone}${b.tone === "working" || open === `bar:${x.id}` ? " on" : ""}`} aria-label={`Captain of ${x.project.name}`} title={b.line}>
        <span className="mgr-crow-face">
          {/* No ring round its face (Arun, 2026-11-28: "get rid of the ring around the mascot too"): the Working chip says it. */}
          <ManagerFace m={x} size={20} />
        </span>
        <span className="mgr-crow-name">{x.project.name}</span>
        <span className="mgr-crow-r">
          {b.tone === "working" ? <StatusChip tone="working">{b.pill ?? "Working"}</StatusChip> : b.pill ? <span className={`mgr-crow-pill mgr-st ${b.tone}`}>{b.pill}</span> : b.tone === "off" ? <span className="mgr-st">Off</span> : null}
        </span>
        <span className="mgr-crow-line">{b.line}</span>
        {b.tone === "working" && (
          <span className="mgr-crow-step">
            {b.tool && <EngineMark tool={b.tool} size={11} />}
            <span className="mgr-crow-step-t">
              {b.prog ? `step ${Math.min(b.prog.done + 1, b.prog.of)} of ${b.prog.of}` : b.tool ? (ENGINE_NAMES[b.tool] ?? b.tool) : "Working"}
              {b.since ? (
                <>
                  {" · "}
                  <LiveClock since={b.since} className="mgr-crow-clock" />
                </>
              ) : null}
            </span>
            {/* A dot per thread: the whole project at a glance, working, needs you, ready, idle. */}
            {b.crew ? (
              b.crew.length > 1 && (
                <span className="mgr-crow-dots" aria-hidden>
                  {b.crew.slice(0, 8).map((a) => (
                    <i key={a.id} className={a.status === "done" ? "ready" : a.status} />
                  ))}
                </span>
              )
            ) : ts.length > 1 && (
              <span className="mgr-crow-dots" aria-hidden>
                {ts.slice(0, 8).map((t) => (
                  <i key={t.sid} className={t.state === "working" ? "working" : t.state === "needs" ? "needs" : x.ready?.some((r) => r.sid === t.sid) ? "ready" : ""} />
                ))}
              </span>
            )}
          </span>
        )}
        {b.tone === "needs" && (
          <span className="mgr-crow-step">
            <span className="mgr-crow-step-t">{b.at ? (elapsed(b.at, now) === "now" ? "just now" : `${elapsed(b.at, now)} ago`) : ""}</span>
            {/* The row opens the window, where the question is; this says so. */}
            <span className="mgr-crow-act" aria-hidden>
              {b.act ?? "Answer"}
            </span>
          </span>
        )}
      </button>,
    );
  };
  const on = m.managers.filter((x) => x.on);
  const working = on.reduce((n, x) => n + (st(x).working ?? 0), 0);
  const needs = on.reduce((n, x) => n + (st(x).needs ?? 0), 0);
  // A Captain v2 held up by a failed step or unable to start: one each, so a folded bar still says so.
  const failed = on.filter((x) => st(x).tone === "failed").length;
  // The Running now list hangs from the bar, as wide as it (the kit's Popover closes it on a press outside or Esc).
  const runRef = useRef<HTMLDivElement>(null);
  const add = (
    <button type="button" className="mgr-bar-add" onClick={() => onAdd()} aria-label="Set up a Captain" title="Set up a Captain">
      <Icon name="plus" size={13} />
    </button>
  );
  return (
    <div className={`mgr-bar${unfolded ? " unfolded" : ""}`} data-testid="managers-bar" ref={runRef}>
      <div className="mgr-bar-head">
        <button type="button" className="mgr-bar-fold" onClick={fold} aria-expanded={unfolded} aria-label={unfolded ? "Fold the Captains" : "Unfold the Captains"}>
          <Icon name="chevronRight" size={12} className="sb-fold-chev mgr-bar-chev" />
          <b>Captains</b>
          {!m.managers.length && <span>{projects.size ? "One per project" : "Pick a project folder first"}</span>}
        </button>
        {!unfolded && (working > 0 || needs > 0 || failed > 0) && (
          <button type="button" className="mgr-rn" aria-expanded={running} aria-label="Running now" title={[working && `${working} working`, needs && `${needs} needs you`, failed && `${failed} failed`].filter(Boolean).join(" · ")} onClick={() => setRunning(!running)}>
            {working > 0 && (
              <span>
                <span className="mgr-st-ring" aria-hidden />
                <span>
                  {working}
                  <span className="mgr-rn-w"> working</span>
                </span>
              </span>
            )}
            {working > 0 && needs > 0 && <i className="mgr-rn-sep" aria-hidden />}
            {needs > 0 && (
              <span>
                <i className="mgr-rn-dot" aria-hidden />
                <span>
                  {needs}
                  <span className="mgr-rn-w"> needs you</span>
                </span>
              </span>
            )}
            {failed > 0 && (
              <span className="mgr-rn-fail">
                <i className="mgr-rn-dot" aria-hidden />
                <span>
                  {failed}
                  <span className="mgr-rn-w"> failed</span>
                </span>
              </span>
            )}
          </button>
        )}
        {/* Folded with the chip showing, the line is the mock's: the chip ends it; + is back when unfolded or quiet. */}
        {(unfolded || !(working > 0 || needs > 0 || failed > 0)) && add}
      </div>
      {/* Opens and shuts as the project cards do (sidebar-fold.tsx; Arun, 2026-11-27: "iron out any laggy/buggy closing and opening
          of the project cards and stuff in the side bar"). */}
      {m.managers.length > 0 && (
        <Fold open={unfolded}>
          <div className="mgr-crows">{m.managers.map(row)}</div>
        </Fold>
      )}
      {/* Folded, each Captain's window still opens, from the Running now list. */}
      {!unfolded && m.managers.map((x) => pop(x, <span hidden />, "run"))}
      {!unfolded && running && (
        <Suspense fallback={null}>
          <LazyRunning managers={on} api={m} anchor={runRef} onClose={() => setRunning(false)} onOpen={(x) => (setRunning(false), dispatchEvent(new CustomEvent("friday:captain", { detail: x.id })))} />
        </Suspense>
      )}
    </div>
  );
}

/** A project's tile with its Captain's face on its corner. */
export function ManagedTile({ m, tile }: { m: ManagerView; tile: ReactNode }) {
  return (
    <span className="mgr-tile">
      {tile}
      <span className="mgr-tile-face">
        <ManagerFace m={m} size={12} />
      </span>
    </span>
  );
}

/** Its one line under the project's name: "Captain · Run · 3 running", and the tab's ring. Opens its panel. */
export function ManagerLine({ m, p, ...rest }: { m: ManagerView; p: ManagedProject | undefined } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const asks = forYouOf(m).length + (p?.needs ?? 0);
  const what = !m.on ? "off" : asks ? `${asks} for you` : p?.running ? `${p.running} running` : m.queue.length ? `${m.queue.length} queued` : "all quiet";
  return (
    <button type="button" className="mgr-line" data-testid="manager-line" {...rest}>
      <TabRing state={ringOf(m, p)} />
      <b>Captain</b>
      <span>· {modeOf(m)}</span>
      <span className={asks && m.on ? "mgr-asks" : ""}>· {what}</span>
    </button>
  );
}


/**
 * Its strip in the project's card, between the facts and the threads (the B layout): its face, "Captain" with its level and the
 * session tab's small ring, what it did last, and its questions as one pill. Opens its panel.
 */
export function CaptainStrip({ m, p, ...rest }: { m: ManagerView; p: ManagedProject | undefined } & ButtonHTMLAttributes<HTMLButtonElement>) {
  // A band across the top of its project's card (2026-11-25: H, "keep it clean and only important stuff like status and mode"):
  // its face, Captain and its mode, and how it stands in a word or a count. What it did lives in its popover.
  const asks = m.on ? forYouOf(m).length + (p?.needs ?? 0) : 0;
  const ready = m.on ? (m.ready?.length ?? 0) : 0;
  const ring = ringOf(m, p);
  // A Captain v2 by its own live state, its words as the bar's (never the project's threads, which are the person's).
  const v2 = m.autonomy ? stateOf(m, p, Date.now()) : null;
  const tone = v2 ? v2.tone : !m.on ? "off" : asks > 0 ? "needs" : ready > 0 ? "ready" : ring === "working" ? "working" : "quiet";
  return (
    <button type="button" className={`mgr-strip mgr-band ${tone}`} data-testid="captain-strip" {...rest}>
      <ManagerFace m={m} size={16} />
      <span className="mgr-band-t">
        <b>Captain</b>
        <span className="mgr-band-lv">{modeOf(m)}</span>
      </span>
      {/* How it stands at the line's end (Arun, 2026-11-27, the approved mock): a chip when something is at work, asks or is ready,
          else in a word. */}
      {v2 ? (
        v2.pill ? <span className={`mgr-band-pill ${v2.cls}`}>{v2.pill}</span> : <span className="mgr-band-s" title={v2.line}>{v2.tone === "off" ? "Paused" : v2.line}</span>
      ) : asks > 0 ? (
        <span className="mgr-band-pill">{asks} needs you</span>
      ) : ready > 0 ? (
        <span className="mgr-band-pill ready">{ready} ready</span>
      ) : m.on && ring === "working" ? (
        <span className="mgr-band-pill work">{p?.running || 1} working</span>
      ) : (
        <span className="mgr-band-s">{!m.on ? "Paused" : "All quiet"}</span>
      )}
    </button>
  );
}

export const clockOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** A ready item's facts in a few words: "tests pass · 4 files · +27 −3". */
export const readyFacts = (r: ReadyItem) =>
  r.facts
    .replace(/^(Checked|Done)\s*·\s*/i, "")
    .replace(/(\d+ files?) ([+−-])/, "$1 · $2")
    .replace(/^./, (c) => c.toUpperCase());

const CaptainWindow = lazy(() => import("./ManagerWindow.js").then((x) => ({ default: x.CaptainWindow })));
const LazySetup = lazy(() => import("./ManagerWindow.js").then((x) => ({ default: x.ManagerSetup })));

/**
 * The panel as a modal opened from anything inside `children` (2026-11-25: "into a modal as well so we have more space"): its
 * header, then two columns. Its settings open in their own modal from its gear.
 */
export function ManagerPopover({ m, p, api, open, onOpenChange, children }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; open: boolean; onOpenChange: (v: boolean) => void; children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const trigger = isValidElement<{ onClick?: (e: React.MouseEvent) => void }>(children)
    ? cloneElement(children, {
        onClick: (e: React.MouseEvent) => {
          children.props.onClick?.(e);
          // The Captain is a page now (CaptainPage.tsx; Arun, 2026-11-27: "make it a page ... instead of a modal").
          dispatchEvent(new CustomEvent("friday:captain", { detail: m.id }));
        },
      })
    : children;
  // The window and its settings load the first time one is opened, not with the sidebar (the first screen's budget).
  const [used, setUsed] = useState(false);
  if ((open || sheet) && !used) setUsed(true);
  return (
    <>
      {trigger}
      {used && (
        <Suspense fallback={null}>
          <CaptainWindow m={m} p={p} api={api} open={open} onOpenChange={onOpenChange} sheet={sheet} setSheet={setSheet} />
        </Suspense>
      )}
    </>
  );
}

/** The New Captain sheet, loaded the first time it opens. */
export function ManagerSetup(props: { api: ManagersApi; projects: readonly { name: string; folder: string }[]; initial?: string; open: boolean; onClose: () => void }) {
  const [used, setUsed] = useState(false);
  if (props.open && !used) setUsed(true);
  return used ? (
    <Suspense fallback={null}>
      <LazySetup {...props} />
    </Suspense>
  ) : null;
}
