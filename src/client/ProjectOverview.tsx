// The project overview (Arun, 2026-11-27: "a agent overview of thread(s) in one view for a project ... using these make it
// advanced but simple to understand", of affectUI's Agent Fleet and Agent Tree; then: "it shold feel like a map or something...
// where you can drag around and stuff to seee everything instead of thread tabs... and make it a page within the window").
// A page: every thread of the project at once as its own tree (the thread, its agents side by side under it, each agent's
// subagents hanging below), laid out on a map you drag and zoom, with a minimap. Rebuilt by hand from the kit's previews, in
// Friday's tokens: grey connectors (colour is for state), time instead of dollars.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HubAgent } from "../agents-hub.js";
import type { SubTask } from "../sub-tasks.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, MAIN_LANE } from "../types.js";
import { focusAgent } from "./agentFocus.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { TreeMark } from "./tree-mark.js";
import { onBand } from "./ui.js";
import { shortTokens } from "../tool-usage.js";
import { useNow } from "./presence.js";
import type { Identity, Project, RecentSession } from "./storage.js";
import { isTeamSid } from "./Teammates.js";
import "./project-overview.css";

interface Thread {
  sid: string;
  title: string;
  lead: string | null;
  agents: HubAgent[];
  subs: SubTask[];
  /** The change it carries and its branch, and its pull request, as its sidebar row has them (attention.ts). */
  facts?: { files: number; added: number; removed: number; branch?: string };
  pr?: { url: string; merged: boolean };
}
type Tone = "work" | "need" | "done" | "fail" | "idle";
const WORD: Record<Tone, string> = { work: "Working", need: "Needs you", done: "Done", fail: "Failed", idle: "Quiet" };
const RANK: Record<Tone, number> = { need: 0, work: 1, fail: 2, done: 3, idle: 4 };

const toneOfAgent = (a: HubAgent): Tone => (a.needsYou ? "need" : a.status === "working" ? "work" : a.status === "failed" ? "fail" : a.status === "done" ? "done" : "idle");
const toneOfSub = (t: SubTask): Tone => (t.status === "running" ? "work" : t.status === "error" ? "fail" : t.status === "stopped" ? "idle" : "done");
const toneOfThread = (t: Thread): Tone => t.agents.map(toneOfAgent).sort((a, b) => RANK[a] - RANK[b])[0] ?? "idle";

/** "4m 05s", "1h 12m", "38s": how long, as the kit's cards say it. */
function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
/** "now", "4m ago", "2h ago", "3d ago". */
const ago = (at: number, now: number) => {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};
/** "950", "8.5k", "4.6M": counts as the rest of the app reads them (tool-usage.ts; Arun, 2026-11-27: "4601k tokens ... handle Ms"). */
const short = shortTokens;
/** When a thread last did anything: now while it works, else its agents' latest. */
const lastOf = (t: Thread, now: number) => (t.agents.some((a) => toneOfAgent(a) === "work") ? now : Math.max(0, ...t.agents.map((a) => a.endedAt ?? a.startedAt ?? 0)));
/** Whether a thread has what's being looked for: its title, its agents' names and lines, its subagents'. */
const matches = (t: Thread, title: string, q: string) => {
  const k = q.trim().toLowerCase();
  return !k || [title, ...t.agents.flatMap((a) => [a.name, a.line]), ...t.subs.flatMap((x) => [x.agentType ?? "", x.description, x.doing ?? ""])].some((w) => w?.toLowerCase().includes(k));
};

const span = (from: number | null | undefined, to: number | null | undefined, now: number) => (from ? took((to ?? now) - from) : "");
const readPref = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* Only this time, then. */
  }
};
const LANES: { tone: Tone; word: string }[] = [
  { tone: "need", word: "Needs you" },
  { tone: "work", word: "Working" },
  { tone: "fail", word: "Stopped" },
  { tone: "done", word: "Done" },
  { tone: "idle", word: "Quiet" },
];

/**
 * The threads of a session's project, exactly as the sidebar files them (the list it shows: App's recents, which leave out Code's
 * own chats, less the Crew's): its project's, else the unfiled ones in the same repo. Reading storage directly listed Code's
 * chats too, threads nobody sees in the sidebar (Arun, 2026-11-27: "it is showing extra threads that arent even there").
 */
export function projectThreads(sid: string, recents: readonly RecentSession[], projects: readonly Project[]): { name: string; id?: string; threads: RecentSession[] } {
  const listed = recents.filter((r) => !isTeamSid(r.sid));
  const me = listed.find((r) => r.sid === sid);
  const filed = me?.projectId ? projects.find((p) => p.id === me.projectId) : undefined;
  const filedIds = new Set(projects.map((p) => p.id));
  const repo = me?.repos?.[0]?.name;
  const threads = filed ? listed.filter((r) => r.projectId === filed.id) : repo ? listed.filter((r) => !(r.projectId && filedIds.has(r.projectId)) && r.repos?.[0]?.name === repo) : me ? [me] : [];
  return { name: filed?.name ?? repo ?? me?.title ?? "This project", ...(filed ? { id: filed.id } : {}), threads: [...threads].sort((a, b) => b.openedAt - a.openedAt).slice(0, 40) };
}

function Chip({ tone, word }: { tone: Tone; word?: string }) {
  return (
    <span className={`pov-chip is-${tone}`}>
      {tone === "work" ? <i className="pov-spin" aria-hidden /> : <i className="pov-dot" aria-hidden />}
      {word ?? WORD[tone]}
    </span>
  );
}

const MIN = 0.25;
const MAX = 1.6;
const clampK = (k: number) => Math.min(MAX, Math.max(MIN, k));
interface View {
  x: number;
  y: number;
  k: number;
}

export default function ProjectOverview({ identity, sid, recents, projects, onBack, onNew }: { identity: Identity; sid: string; recents: readonly RecentSession[]; projects: readonly Project[]; onBack: () => void; /** A new thread in this project (App: the start page, filed under it). */ onNew?: (projectId?: string) => void }) {
  const project = useMemo(() => projectThreads(sid, recents, projects), [sid, recents, projects]);
  const sids = project.threads.map((t) => t.sid).join(",");
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [filter, setFilter] = useState<"all" | "work" | "need">("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // How the map is laid out: a field of threads, or columns by where they stand (Needs you, Working, Done, Quiet).
  const [layout, setLayout] = useState<"grid" | "state">(() => (readPref("friday.overview.layout") === "state" ? "state" : "grid"));
  // Follow: the map goes to a thread as it starts working or comes to need you.
  const [follow, setFollow] = useState(() => readPref("friday.overview.follow") === "1");
  // The thread picked with J and K (or a press on its ground), which Enter opens.
  const [sel, setSel] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const find = useRef<HTMLInputElement>(null);
  const now = useNow(1000);
  // In the desktop app its bar is the window's own band, as a session's header is (Arun, 2026-11-27: "move this to the header",
  // "line up the horinontal line at the top"); in a browser, a bar of its own.
  const [band, setBand] = useState<{ left: HTMLElement; right: HTMLElement } | null>(null);
  useLayoutEffect(
    () =>
      onBand(() => {
        const left = document.getElementById("band-left");
        const right = document.getElementById("band-slot");
        if (!left || !right) return;
        setBand({ left, right });
        // Laid out as a session's header is (SessionView.tsx): both halves on one row, in line with the rail's first row, and the
        // map starting under it. As a page's, its left half sat a row lower than its right, over the map (Arun, 2026-11-27: "still
        // not fixed properly").
        document.documentElement.dataset.band = "session";
        return () => {
          setBand(null);
          if (document.documentElement.dataset.band === "session") delete document.documentElement.dataset.band;
        };
      }),
    [],
  );

  // Read while open: every few seconds, as the board does; a thread's own cache answers when nothing moved.
  useEffect(() => {
    let live = true;
    const list = sids ? sids.split(",") : [];
    const read = () =>
      api<{ threads: Thread[] }>(identity, "/api/overview", { method: "POST", body: JSON.stringify({ sids: list }) })
        .then((r) => live && setThreads(r.threads))
        .catch(() => live && setThreads((was) => was ?? []));
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 3000);
    return () => ((live = false), clearInterval(t));
  }, [identity, sids]);

  const titled = useCallback((t: Thread) => project.threads.find((r) => r.sid === t.sid)?.alias || t.title || "Untitled thread", [project]);
  // The order the threads keep on the map: as the sidebar has them (newest opened first), so a state change never moves one.
  const order = useMemo(() => project.threads.map((r) => threads?.find((t) => t.sid === r.sid)).filter((t): t is Thread => !!t), [project, threads]);
  const counts = { work: order.filter((t) => toneOfThread(t) === "work").length, need: order.filter((t) => toneOfThread(t) === "need").length };
  const agents = order.reduce((n, t) => n + t.agents.length, 0);
  const working = order.reduce((n, t) => n + t.agents.filter((a) => toneOfAgent(a) === "work").length, 0);
  const needs = order.reduce((n, t) => n + t.agents.filter((a) => a.needsYou).length, 0);
  // The project's totals for the status bar: tokens, the change it carries, its pull requests.
  const tokens = order.reduce((n, t) => n + t.agents.reduce((m, a) => m + (a.tokens || 0), 0), 0);
  const change = order.reduce((c, t) => ({ files: c.files + (t.facts?.files ?? 0), added: c.added + (t.facts?.added ?? 0), removed: c.removed + (t.facts?.removed ?? 0) }), { files: 0, added: 0, removed: 0 });
  const prs = { open: order.filter((t) => t.pr && !t.pr.merged).length, merged: order.filter((t) => t.pr?.merged).length };
  const lit = (t: Thread) => (filter === "all" || toneOfThread(t) === filter) && matches(t, titled(t), query);
  const found = query.trim() ? order.filter((t) => matches(t, titled(t), query)) : [];
  // Every agent with subagents under it, for Fold all: folded together, opened together.
  const branches = order.flatMap((t) => t.agents.filter((a) => t.subs.some((x) => x.lane === a.lane)).map((a) => `${t.sid}:${a.lane}`));
  const allFolded = branches.length > 0 && branches.every((b) => folded.has(b));

  const go = useCallback(
    (t: Thread, lane?: string) => {
      const invite = project.threads.find((r) => r.sid === t.sid)?.invite;
      dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: t.sid, ...(invite ? { invite } : {}) } }));
      if (lane) focusAgent(t.sid, lane);
    },
    [project],
  );

  // ── The map: the world is translated and scaled; drag its ground to move, scroll to move, ⌘ or a pinch to zoom.
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0, ww: 0, wh: 0 });
  const fitted = useRef(false);
  const measure = useCallback(() => {
    const s = stage.current;
    const w = world.current;
    if (!s || !w) return;
    setSize({ w: s.clientWidth, h: s.clientHeight, ww: w.offsetWidth, wh: w.offsetHeight });
  }, []);
  const fitTo = useCallback((box?: { x: number; y: number; w: number; h: number }) => {
    const s = stage.current;
    const w = world.current;
    if (!s || !w) return;
    const b = box ?? { x: 0, y: 0, w: w.offsetWidth, h: w.offsetHeight };
    const pad = 48;
    const k = clampK(Math.min((s.clientWidth - pad * 2) / Math.max(1, b.w), (s.clientHeight - pad * 2) / Math.max(1, b.h), 1));
    setView({ k, x: (s.clientWidth - b.w * k) / 2 - b.x * k, y: Math.max(pad, (s.clientHeight - b.h * k) / 2) - b.y * k });
  }, []);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    if (world.current) ro.observe(world.current);
    return () => ro.disconnect();
  }, [measure, order.length]);
  // Where you left this project's map, for the window's life: back from a thread, it is as it was. Else fitted, so the first look
  // shows the whole project.
  const viewKey = `friday.overview.view:${project.name}`;
  useLayoutEffect(() => {
    if (fitted.current || !order.length || !size.ww) return;
    fitted.current = true;
    try {
      const was = JSON.parse(sessionStorage.getItem(viewKey) ?? "null") as View | null;
      if (was && Number.isFinite(was.k)) return setView({ x: was.x, y: was.y, k: clampK(was.k) });
    } catch {
      /* Fitted instead. */
    }
    fitTo();
  }, [order.length, size.ww, fitTo, viewKey]);
  useEffect(() => {
    if (!fitted.current) return;
    const t = setTimeout(() => {
      try {
        sessionStorage.setItem(viewKey, JSON.stringify(view));
      } catch {
        /* Not kept: it fits again next time. */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [view, viewKey]);

  const zoomAt = useCallback((k: number, cx: number, cy: number) => {
    setView((v) => {
      const nk = clampK(k);
      return { k: nk, x: cx - ((cx - v.x) / v.k) * nk, y: cy - ((cy - v.y) / v.k) * nk };
    });
  }, []);
  const zoomBy = (f: number) => zoomAt(view.k * f, size.w / 2, size.h / 2);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = s.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        setView((v) => {
          const nk = clampK(v.k * Math.exp(-e.deltaY * 0.01));
          const cx = e.clientX - r.left;
          const cy = e.clientY - r.top;
          return { k: nk, x: cx - ((cx - v.x) / v.k) * nk, y: cy - ((cy - v.y) / v.k) * nk };
        });
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    s.addEventListener("wheel", wheel, { passive: false });
    return () => s.removeEventListener("wheel", wheel);
  }, []);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, [role=treeitem], .pov-mini")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGrabbing(true);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const up = () => ((drag.current = null), setGrabbing(false));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") return (e.preventDefault(), onBack());
      if (e.key === "/") return (e.preventDefault(), find.current?.focus());
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "=" || e.key === "+") return (e.preventDefault(), zoomAt(view.k * 1.2, size.w / 2, size.h / 2));
      if (e.key === "-") return (e.preventDefault(), zoomAt(view.k / 1.2, size.w / 2, size.h / 2));
      if (e.key === "0") return (e.preventDefault(), fitTo());
      if (e.key === "j") return (e.preventDefault(), pick(1));
      if (e.key === "k") return (e.preventDefault(), pick(-1));
      if (e.key === "Enter" && sel) {
        const t = order.find((x) => x.sid === sel);
        if (t) return (e.preventDefault(), go(t));
      }
      if (e.key === "l") return (e.preventDefault(), setLayout((v) => (writePref("friday.overview.layout", v === "grid" ? "state" : "grid"), v === "grid" ? "state" : "grid")));
      if (e.key === "f") return (e.preventDefault(), setFollow((v) => (writePref("friday.overview.follow", v ? "0" : "1"), !v)));
      if (e.key === "n" && onNew) return (e.preventDefault(), onNew(project.id));
      const step = 80;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const a = arrows[e.key];
      if (a) (e.preventDefault(), setView((v) => ({ ...v, x: v.x + a[0], y: v.y + a[1] })));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onBack, zoomAt, fitTo, view.k, size, sel, order, go, onNew, project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A cluster's box on the world, for the minimap and for zooming to one thread.
  const [boxes, setBoxes] = useState<{ sid: string; x: number; y: number; w: number; h: number }[]>([]);
  useLayoutEffect(() => {
    const w = world.current;
    if (!w) return;
    // Measured on the world's own unscaled plane, whichever lane a thread sits in.
    const o = w.getBoundingClientRect();
    const k = o.width / Math.max(1, w.offsetWidth) || 1;
    setBoxes([...w.querySelectorAll<HTMLElement>("[data-cluster]")].map((c) => {
      const r = c.getBoundingClientRect();
      return { sid: c.dataset.cluster!, x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: c.offsetWidth, h: c.offsetHeight };
    }));
  }, [order, folded, size.ww, size.wh, layout]);
  const zoomTo = useCallback(
    (id: string) => {
      const b = boxes.find((x) => x.sid === id);
      if (b) fitTo({ x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 });
    },
    [boxes, fitTo],
  );
  // A new layout fits again once its threads have moved.
  const laid = useRef(layout);
  useLayoutEffect(() => {
    if (laid.current !== layout && boxes.length) ((laid.current = layout), fitTo());
  }, [layout, boxes, fitTo]);
  // Follow: a thread that starts working or comes to need you is gone to, and picked; needing you wins.
  const was = useRef(new Map<string, Tone>());
  useEffect(() => {
    const before = was.current;
    was.current = new Map(order.map((t) => [t.sid, toneOfThread(t)]));
    if (!follow || !before.size) return;
    const moved = order.filter((t) => before.get(t.sid) !== toneOfThread(t) && (toneOfThread(t) === "need" || toneOfThread(t) === "work")).sort((a, b) => RANK[toneOfThread(a)] - RANK[toneOfThread(b)]);
    if (moved[0]) (setSel(moved[0].sid), zoomTo(moved[0].sid));
  }, [order, follow, zoomTo]);
  const pick = (d: number) => {
    const list = order.filter(lit);
    if (!list.length) return;
    const i = list.findIndex((t) => t.sid === sel);
    const next = list[(i + d + list.length) % list.length]!;
    setSel(next.sid);
    zoomTo(next.sid);
  };

  // About square: as many columns as rows, so the map is a field rather than a strip.
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));

  const head: ReactNode = (
    <div className="pov-head">
      <button type="button" className="pov-back" onClick={onBack} title="Back to the thread · Esc">
        <Icon name="arrowLeft" size={14} />
        Back
      </button>
      <span className="pov-ttl">
        <span className="pov-tile">{project.name.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "P"}</span>
        {project.name}
      </span>
    </div>
  );
  const tools: ReactNode = (
    <div className="pov-tools">
      <label className="pov-find">
        <Icon name="search" size={13} />
        <input
          ref={find}
          value={query}
          placeholder="Find a thread or agent"
          aria-label="Find a thread or agent"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setQuery(""), e.currentTarget.blur());
            if (e.key === "Enter" && found[0]) (e.preventDefault(), zoomTo(found[0].sid));
          }}
        />
        {query.trim() ? <em>{found.length}</em> : <kbd>/</kbd>}
      </label>
      <span className="pov-seg" role="group" aria-label="Light up">
        {(
          [
            ["all", "All", order.length],
            ["work", "Working", counts.work],
            ["need", "Needs you", counts.need],
          ] as const
        ).map(([k, label, n]) => (
          <button key={k} type="button" className={filter === k ? "on" : ""} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <em>{n}</em>
          </button>
        ))}
      </span>
      {onNew && (
        <button type="button" className="pov-new" onClick={() => onNew(project.id)} title={`A new thread in ${project.name} · N`}>
          <Icon name="plus" size={13} />
          New thread
        </button>
      )}
    </div>
  );
  const cluster = (t: Thread, i: number) => (
    <Cluster
      key={t.sid}
      t={t}
      i={i}
      here={t.sid === sid}
      picked={t.sid === sel}
      dim={!lit(t)}
      title={titled(t)}
      now={now}
      folded={folded}
      onFold={(id) => setFolded((was) => new Set(was.has(id) ? [...was].filter((x) => x !== id) : [...was, id]))}
      onAgent={(lane) => go(t, lane)}
      onThread={() => go(t)}
      onZoom={() => (setSel(t.sid), zoomTo(t.sid))}
      onPick={() => setSel(t.sid)}
    />
  );

  return (
    <div className={`pov-page${band ? " in-band" : ""}`} role="region" aria-label={`${project.name}: every thread and its agents`}>
      {band ? (
        <>
          {createPortal(head, band.left)}
        </>
      ) : (
        <div className="pov-bar">
          {head}
          {tools}
        </div>
      )}

      <div ref={stage} className={`pov-stage${grabbing ? " grabbing" : ""}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={(e) => !(e.target as HTMLElement).closest("[role=treeitem], button, [data-cluster]") && fitTo()} aria-label="The map: drag to move, scroll to move, ⌘ and scroll to zoom">
        <div ref={world} className={`pov-world${layout === "state" ? " by-state" : ""}`} style={{ transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.k})`, ...(layout === "grid" ? { gridTemplateColumns: `repeat(${cols}, auto)` } : {}) } as CSSProperties}>
          {!threads && [0, 1, 2, 3].map((i) => <div key={i} className="pov-cluster pov-skel" aria-hidden />)}
          {layout === "grid"
            ? order.map(cluster)
            : // By state: a column per state that has a thread, its threads under its name, newest opened first.
              LANES.map(({ tone, word }) => {
                const here = order.filter((t) => toneOfThread(t) === tone);
                return here.length ? (
                  <section key={tone} className={`pov-lane is-${tone}`} aria-label={word}>
                    <h3 className="pov-lane-h">
                      <Chip tone={tone} word={word} />
                      <em>{here.length}</em>
                    </h3>
                    {here.map((t) => cluster(t, order.indexOf(t)))}
                  </section>
                ) : null;
              })}
        </div>
        {threads && !order.length && (
          <div className="pov-empty">
            <TreeMark size={28} />
            <b>No threads in {project.name} yet</b>
            <span>Start one from the sidebar and it shows here with its agents.</span>
          </div>
        )}

        {boxes.length > 1 && size.ww > 0 && (
          <Minimap boxes={boxes} tones={new Map(order.map((t) => [t.sid, lit(t) ? toneOfThread(t) : "dim"]))} world={{ w: size.ww, h: size.wh }} view={view} stage={size} onCenter={(x, y) => setView((v) => ({ ...v, x: size.w / 2 - x * v.k, y: size.h / 2 - y * v.k }))} />
        )}

        {/* Find, the filter and New thread on the map's top row, across from This thread (Arun, 2026-11-28: "move this from the
            header and line it up with the this thread button"); a browser's own bar keeps them. */}
        {band && (
          <div className="pov-stage-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {tools}
          </div>
        )}
        <div className="pov-tray" role="group" aria-label="Map">
          {order.some((t) => t.sid === sid) && (
            <button type="button" onClick={() => zoomTo(sid)} title="Go to the thread you came from">
              <Icon name="pin" size={13} />
              This thread
            </button>
          )}
          {branches.length > 0 && (
            <button type="button" aria-pressed={allFolded} onClick={() => setFolded((was) => (allFolded ? new Set([...was].filter((x) => !branches.includes(x))) : new Set([...was, ...branches])))} title={allFolded ? "Show every agent's subagents" : "Fold every agent's subagents into its count"}>
              <Icon name={allFolded ? "chevronDown" : "chevronRight"} size={13} />
              {allFolded ? "Show subagents" : "Fold subagents"}
            </button>
          )}
        </div>
        {help && (
          <div className="pov-help" role="dialog" aria-label="Shortcuts">
            <b>Shortcuts</b>
            {(
              [
                ["Drag, scroll", "Move the map"],
                ["⌘ scroll, + −", "Zoom"],
                ["0", "Fit everything"],
                ["J  K", "Next and previous thread"],
                ["Enter", "Open the picked thread"],
                ["/", "Find a thread or agent"],
                ["L", "Grid or by state"],
                ["F", "Follow what's working"],
                ["N", "New thread here"],
                ["Esc", "Back to the thread"],
              ] as const
            ).map(([k, w]) => (
              <span key={k}>
                <kbd>{k}</kbd>
                {w}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* The status bar: the zoom, the project's totals, and how the map is laid out and whether it follows the work (Arun,
          2026-11-27: "get rid of this in the header and add it to the bottom row here"). */}
      <div className="pov-status">
        <div className="pov-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" title="Zoom out · −" onClick={() => zoomBy(1 / 1.2)}>
            <Icon name="minus" size={13} />
          </button>
          <button type="button" className="pov-zoom-n" aria-label="Fit everything" title="Fit everything · 0" onClick={() => fitTo()}>
            {Math.round(view.k * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in · +" onClick={() => zoomBy(1.2)}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        <div className="pov-sum" aria-live="polite">
          <span>
            {order.length} thread{order.length === 1 ? "" : "s"}
          </span>
          <span>
            {agents} agent{agents === 1 ? "" : "s"}
          </span>
          {working > 0 && <span className="pov-run">{working} working</span>}
          {needs > 0 && <Chip tone="need" word={`${needs} need${needs === 1 ? "s" : ""} you`} />}
          {threads && !working && !needs && <span>All quiet</span>}
          {tokens > 0 && <span title={`${tokens.toLocaleString()} tokens across the project's agents`}>{short(tokens)} tokens</span>}
          {change.files > 0 && (
            <span>
              {change.files} file{change.files === 1 ? "" : "s"} <b className="pov-plus">+{short(change.added)}</b> <b className="pov-minus">−{short(change.removed)}</b>
            </span>
          )}
          {prs.open + prs.merged > 0 && (
            <span>
              {[prs.open ? `${prs.open} PR${prs.open === 1 ? "" : "s"} open` : "", prs.merged ? `${prs.merged} merged` : ""].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <div className="pov-status-r">
          <button type="button" className="pov-tog" aria-pressed={follow} onClick={() => setFollow((v) => (writePref("friday.overview.follow", v ? "0" : "1"), !v))} title="Go to a thread as it starts working or comes to need you · F">
            <i className={follow ? "on" : ""} aria-hidden />
            Follow
          </button>
          <span className="pov-seg" role="group" aria-label="Layout">
            {(
              [
                ["grid", "Grid"],
                ["state", "By state"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={layout === k ? "on" : ""} aria-pressed={layout === k} onClick={() => (writePref("friday.overview.layout", k), setLayout(k))} title="L">
                {label}
              </button>
            ))}
          </span>
          <button type="button" className="pov-x" aria-label="Shortcuts" aria-pressed={help} title="Shortcuts" onClick={() => setHelp((v) => !v)}>
            ?
          </button>
        </div>
      </div>
    </div>
  );
}

/** The minimap: every thread's box, in its state's colour, and the window's view; a press there moves the view to it. */
function Minimap({ boxes, tones, world, view, stage, onCenter }: { boxes: { sid: string; x: number; y: number; w: number; h: number }[]; tones: Map<string, string>; world: { w: number; h: number }; view: View; stage: { w: number; h: number }; onCenter: (x: number, y: number) => void }) {
  const W = 168;
  const s = W / Math.max(1, world.w);
  const H = Math.max(48, Math.min(140, world.h * s));
  const sy = H / Math.max(1, world.h);
  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter((e.clientX - r.left) / s, (e.clientY - r.top) / sy);
  };
  return (
    <div className="pov-mini" style={{ width: W, height: H }} onPointerDown={press} aria-label="Minimap: press to move there" role="img">
      {boxes.map((b) => (
        <i key={b.sid} className={`pov-mini-b is-${tones.get(b.sid) ?? "idle"}`} style={{ left: b.x * s, top: b.y * sy, width: Math.max(3, b.w * s), height: Math.max(3, b.h * sy) }} />
      ))}
      <b className="pov-mini-v" style={{ left: (-view.x / view.k) * s, top: (-view.y / view.k) * sy, width: (stage.w / view.k) * s, height: (stage.h / view.k) * sy }} />
    </div>
  );
}

/** One thread as the kit's Agent Tree: the thread, its agents side by side under it, each one's subagents hanging below it. */
function Cluster({ t, i, here, picked, dim, title, now, folded, onFold, onAgent, onThread, onZoom, onPick }: { t: Thread; i: number; here: boolean; picked: boolean; dim: boolean; title: string; now: number; folded: Set<string>; onFold: (id: string) => void; onAgent: (lane: string) => void; onThread: () => void; onZoom: () => void; onPick: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [d, setD] = useState("");
  const [dots, setDots] = useState<{ x: number; y: number }[]>([]);
  const subsOf = (lane: string) => t.subs.filter((s) => s.lane === lane).sort((a, b) => a.start - b.start);
  const tone = toneOfThread(t);
  const from = Math.min(...t.agents.map((a) => a.startedAt ?? Infinity));
  const to = tone === "work" ? null : Math.max(...t.agents.map((a) => a.endedAt ?? 0));
  const branch = t.agents.find((a) => a.lane === MAIN_LANE)?.branch ?? t.agents[0]?.branch ?? "";
  // Its model when the host picked one; else nothing, rather than the tool's name under the tool's name.
  const modelOf = (a: HubAgent) => (a.model ? (a.tool ? (ENGINE_MODEL_INFO[a.tool]?.find((x) => x.id === a.model)?.label ?? a.model) : a.model) : a.tool && a.name !== ENGINE_NAMES[a.tool] ? ENGINE_NAMES[a.tool] : "");

  // The connectors, measured from the cards in the cluster's own unscaled space (offsets, so the map's zoom never skews them): a
  // rounded elbow from a parent's foot to each child's top, and down the left to each subagent.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const pos = (n: HTMLElement) => {
      let x = 0;
      let y = 0;
      for (let c: HTMLElement | null = n; c && c !== el; c = c.offsetParent as HTMLElement | null) ((x += c.offsetLeft), (y += c.offsetTop));
      return { left: x, top: y, width: n.offsetWidth, height: n.offsetHeight };
    };
    const draw = () => {
      let path = "";
      const feet: { x: number; y: number }[] = [];
      for (const c of el.querySelectorAll<HTMLElement>("[data-parent]")) {
        const p = el.querySelector<HTMLElement>(`[data-node="${CSS.escape(c.dataset.parent!)}"]`);
        if (!p) continue;
        const a = pos(p);
        const b = pos(c);
        if (c.dataset.hang) {
          const x = a.left + 14;
          const y0 = a.top + a.height;
          const y1 = b.top + 18;
          path += `M${x} ${y0}V${y1 - 8}Q${x} ${y1} ${x + 8} ${y1}H${b.left}`;
          if (!feet.some((f) => f.x === x && f.y === y0)) feet.push({ x, y: y0 });
        } else {
          const x0 = a.left + a.width / 2;
          const y0 = a.top + a.height;
          const x1 = b.left + b.width / 2;
          const y1 = b.top;
          const mid = y0 + (y1 - y0) / 2;
          const dir = Math.sign(x1 - x0);
          const r = Math.min(8, Math.abs(x1 - x0) / 2);
          path += Math.abs(x1 - x0) < 1 ? `M${x0} ${y0}V${y1}` : `M${x0} ${y0}V${mid - r}Q${x0} ${mid} ${x0 + dir * r} ${mid}H${x1 - dir * r}Q${x1} ${mid} ${x1} ${mid + r}V${y1}`;
          if (!feet.some((f) => f.x === x0 && f.y === y0)) feet.push({ x: x0, y: y0 });
        }
      }
      setD(path);
      setDots(feet);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t, folded]);

  const agentCard = (a: HubAgent, j: number) => {
    const at = toneOfAgent(a);
    const subs = subsOf(a.lane);
    const lead = t.lead === a.lane && t.agents.length > 1;
    const key = `${t.sid}:${a.lane}`;
    return (
      <div
        role="treeitem"
        aria-label={`${a.name}: ${WORD[at]}`}
        aria-expanded={subs.length ? !folded.has(key) : undefined}
        tabIndex={0}
        data-node={a.lane}
        data-parent="root"
        className={`pov-tn is-${at}`}
        style={{ "--i": i * 2 + j + 1 } as CSSProperties}
        onClick={(e) => !(e.target as HTMLElement).closest("button") && onAgent(a.lane)}
        onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onAgent(a.lane)}
      >
        <span className="pov-tn-top">
          <span className="pov-av">{a.tool ? <EngineMark tool={a.tool} size={13} /> : <Icon name="agent" size={13} />}</span>
          <span className="pov-who">
            <b>{a.name}</b>
            {(modelOf(a) || lead) && <span>{[modelOf(a), lead ? "leads" : ""].filter(Boolean).join(" · ")}</span>}
          </span>
          <Chip tone={at} />
        </span>
        {a.line && <span className={`pov-task${at === "work" ? " pov-shine" : ""}`}>{a.line}</span>}
        {/* Its plan as a bar of steps, when it has one: how far, at a glance. */}
        {a.plan && a.plan.total > 1 && (
          <span className="pov-plan" aria-hidden>
            {Array.from({ length: Math.min(a.plan.total, 12) }, (_, k) => (
              <i key={k} className={k < Math.round((a.plan!.done / a.plan!.total) * Math.min(a.plan!.total, 12)) ? "done" : k === Math.round((a.plan!.done / a.plan!.total) * Math.min(a.plan!.total, 12)) && at === "work" ? "now" : ""} />
            ))}
          </span>
        )}
        <span className="pov-meta">
          <span>{span(a.startedAt, at === "work" ? null : a.endedAt, now)}</span>
          {a.tokens > 0 && <span title={`${a.tokens.toLocaleString()} tokens in this thread`}>· {short(a.tokens)} tokens</span>}
          {a.plan && a.plan.total > 1 && (
            <span>
              · step {Math.min(a.plan.done + (at === "work" ? 1 : 0), a.plan.total)} of {a.plan.total}
            </span>
          )}
          {at === "need" ? (
            <button type="button" className="pov-act" onClick={() => onAgent(a.lane)}>
              Answer
            </button>
          ) : subs.length ? (
            <button type="button" className="pov-fold" aria-label={`${folded.has(key) ? "Show" : "Hide"} ${subs.length} subagent${subs.length === 1 ? "" : "s"} of ${a.name}`} onClick={() => onFold(key)}>
              {subs.length}
              <Icon name={folded.has(key) ? "chevronRight" : "chevronDown"} size={10} />
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  return (
    <div className={`pov-cluster${dim ? " dim" : ""}${here ? " here" : ""}${picked ? " picked" : ""}`} data-cluster={t.sid} ref={box} role="tree" aria-label={`${title}: who started whom`} onClick={(e) => !(e.target as HTMLElement).closest("[role=treeitem], button") && onPick()} onDoubleClick={(e) => !(e.target as HTMLElement).closest("[role=treeitem], button") && (e.stopPropagation(), onZoom())}>
      {/* On hover, its two moves: open it, or fit the map to it. */}
      <span className="pov-acts">
        <button type="button" onClick={onThread} title="Open this thread">
          <Icon name="arrowUpRight" size={12} />
          Open
        </button>
        <button type="button" onClick={onZoom} title="Fit the map to this thread">
          <Icon name="search" size={12} />
          Zoom
        </button>
      </span>
      <svg className="pov-links" aria-hidden>
        <path key={`${t.sid}:${d.length}`} d={d} />
        {dots.map((f) => (
          <circle key={`${f.x}:${f.y}`} cx={f.x} cy={f.y} r={3} />
        ))}
      </svg>
      <div className="pov-lvl">
        <div role="treeitem" aria-label={`${title}: ${WORD[tone]}`} tabIndex={0} data-node="root" className={`pov-tn root is-${tone}`} style={{ "--i": i * 2 } as CSSProperties} onClick={onThread} onKeyDown={(e) => e.key === "Enter" && onThread()}>
          <span className="pov-tn-top">
            <span className="pov-av">
              <TreeMark size={13} />
            </span>
            <span className="pov-who">
              <b>{title}</b>
              <span>{here ? "This thread" : branch || `${t.agents.length} agent${t.agents.length === 1 ? "" : "s"}`}</span>
            </span>
            <Chip tone={tone} />
          </span>
          {/* What it carries: the change, in files and lines, and its pull request. */}
          {(t.facts?.files || t.pr) && (
            <span className="pov-facts">
              {t.facts && t.facts.files > 0 && (
                <span>
                  {t.facts.files} file{t.facts.files === 1 ? "" : "s"} <b className="pov-plus">+{short(t.facts.added)}</b> <b className="pov-minus">−{short(t.facts.removed)}</b>
                </span>
              )}
              {t.pr && (
                <a className={`pov-pr${t.pr.merged ? " merged" : ""}`} href={t.pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={t.pr.url}>
                  <Icon name={t.pr.merged ? "gitMerge" : "gitBranch"} size={11} />
                  {`PR #${/\/pull\/(\d+)/.exec(t.pr.url)?.[1] ?? ""}`.replace(/ #$/, "")} {t.pr.merged ? "merged" : "open"}
                </a>
              )}
            </span>
          )}
          <span className="pov-meta">
            <span>{Number.isFinite(from) ? span(from, to || null, now) : ""}</span>
            <span>
              · {t.agents.length} agent{t.agents.length === 1 ? "" : "s"}
              {t.subs.length ? ` · ${t.subs.length} subagent${t.subs.length === 1 ? "" : "s"}` : ""}
            </span>
            {tone !== "work" && lastOf(t, now) > 0 && <span className="pov-ago">{ago(lastOf(t, now), now)}</span>}
          </span>
        </div>
      </div>
      {t.agents.length > 0 && (
        <div className="pov-lvl">
          {t.agents.map((a, j) => {
            const subs = subsOf(a.lane);
            return (
              <div key={a.lane} className="pov-col" role="group">
                {agentCard(a, j)}
                {subs.length > 0 && !folded.has(`${t.sid}:${a.lane}`) && (
                  <div className="pov-hang">
                    {subs.map((s) => {
                      const st = toneOfSub(s);
                      return (
                        <div key={s.key} role="treeitem" aria-label={`${s.agentType ?? "Subagent"}: ${WORD[st]}`} tabIndex={0} data-node={s.key} data-parent={a.lane} data-hang="1" className={`pov-tn pov-sub is-${st}`} onClick={() => onAgent(a.lane)} onKeyDown={(e) => e.key === "Enter" && onAgent(a.lane)}>
                          <span className="pov-tn-top">
                            <span className="pov-av">
                              <Icon name="gitFork" size={12} />
                            </span>
                            <span className="pov-who">
                              <b>{s.agentType && s.agentType !== "general-purpose" ? s.agentType : "Subagent"}</b>
                              <span>for {a.name}</span>
                            </span>
                            <Chip tone={st} word={st === "idle" ? "Stopped" : undefined} />
                          </span>
                          <span className={`pov-task${st === "work" ? " pov-shine" : ""}`}>{st === "work" && s.doing ? s.doing : s.description}</span>
                          <span className="pov-meta">
                            <span>{took((s.end ?? now) - s.start)}</span>
                            {s.steps ? (
                              <span>
                                · {s.steps} step{s.steps === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
