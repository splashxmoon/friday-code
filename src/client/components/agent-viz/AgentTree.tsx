// Agent Tree (affectUI Pro, rebuilt by hand from its public preview; SPEC agent-tree): who started whom. An orchestrator and its
// sub-agents as a live tree of cards, each with its status, what it was asked, its cost and its time; a parent's cost is its whole
// branch's. A branch folds to its one card. What an agent asks, or why it failed, opens in a small window behind its chip.
// From 560px the first level sits side by side under the root and deeper levels hang below their parent; narrower, every level
// is indented under its parent. The connectors are read off where the cards are, so any width or zoom draws them right.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Popover } from "../affect/popover";
import { Shine } from "../../shine.js";
import { PixelMark, Tile, ToolRow, VizChip, colorOf, statusWord, useReducedMotion, useTick, type VizStatus, type VizTool } from "./viz-parts.js";
import "./agent-viz.css";
import "./agent-tree.css";

export type TreeStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
export type TreeAnswer = "approve" | "reject" | "retry" | "dismiss";

export interface TreeAgent {
  id: string;
  name: string;
  /** What it was asked to do. */
  task: string;
  /** Its model, under the name: "Opus 5.5". */
  model?: string;
  /** What it is on the crew ("Security Engineer"): a line of its own under its name and model. */
  role?: string;
  /** A mark before the model: the coding tool it runs on. */
  modelMark?: ReactNode;
  /** Its face (a coding tool's logo, EngineMark); else its pixel mark. */
  avatar?: ReactNode;
  /** The tools it may use, as small tiles before the task. */
  tools?: VizTool[];
  status: TreeStatus;
  /** Its chip's word in place of its state's usual one (the Captain at rest: "Ready", not "Queued"). */
  word?: string;
  /** What it waits on you for ("waiting"): opens behind its "Needs you" chip. */
  ask?: string;
  /** Why it failed: opens behind its "Failed" chip. */
  error?: string;
  /** Its own cost in dollars; a parent shows its whole branch's. */
  cost?: number;
  /** When it started and ended, in ms. */
  started?: number;
  ended?: number;
  children?: TreeAgent[];
}

export interface AgentTreeProps {
  root: TreeAgent;
  /** The header's title. */
  title?: string;
  icon?: ReactNode;
  /** Folded branches, by id (controlled); or where they start folded. */
  collapsed?: string[];
  defaultCollapsed?: string[];
  onCollapsedChange?: (ids: string[]) => void;
  /** Makes the cards clickable (Enter selects). `how`: a click or Enter ("pick"), or ←/→ moving along the cards ("move"). */
  onSelect?: (agent: TreeAgent, how: "pick" | "move") => void;
  /** The card that is selected (raised, ringed), by id. */
  selected?: string | null;
  /** A click on the tree's empty space: back to no selection. */
  onClear?: () => void;
  /** An answer from an agent's window: approve or reject what it asks, retry or dismiss what failed. */
  onResolve?: (agent: TreeAgent, answer: TreeAnswer) => void;
  /** The window's answers for an agent, in order (the first is primary); absent: Approve/Reject when waiting, Retry/Dismiss when failed. */
  answersFor?: (agent: TreeAgent) => { answer: TreeAnswer; label: string }[];
  /** In place of the bar's icon and title: something of the host's (the Captain page's Recap button). */
  lead?: ReactNode;
  /** Controls at the bar's right end (the Captain page's Start and Stop). */
  trail?: ReactNode;
  /** The bar's counts as the host counts them, in place of the cards' (the Captain page: real agents only, not steps waiting for
   *  one, and every question that needs you, so the bar, the chat's header and the plan card agree). */
  counts?: { agents: number; running: number; waiting: number };
  /** The clock; without it the tree ticks every second while anything runs. */
  now?: number;
  formatCost?: (usd: number) => string;
  label?: string;
  className?: string;
}

const VIZ: Record<TreeStatus, VizStatus> = { queued: "queued", running: "working", waiting: "needs", done: "done", failed: "failed", stopped: "idle" };
const WORDS: Partial<Record<VizStatus, string>> = { working: "Running", needs: "Needs you", queued: "Queued", idle: "Stopped" };
const word = (s: TreeStatus) => statusWord(VIZ[s], WORDS);
const quiet = (s: TreeStatus) => s === "queued" || s === "stopped";
const money = (n: number) => `$${n.toFixed(2)}`;

// Geometry, as measured: cards up to 216 wide, columns 8 apart, each level 32 in, 40 between the root and its row, 12 down a branch.
const CARD = 216;
const NARROW_CARD = 280;
/** The narrowest a card may be side by side: a name, its model and a state chip on one line. */
const SIDE_MIN = 188;
/** The crew as a grid when one row won't take it (Arun, 2026-11-27: "the user cannot have this sized window to see this"): each card
 *  this wide or a little more, columns as many as fit, rows as needed, a bracket down its left joining each row's bus. */
const GRID_MIN = 200;
const GRID_MAX = 232;
const ROW_GAP = 28;
const SPINE = 18;
const GAP = 8;
const INDENT = 32;
const R = 8;

/** "9s", "38s", "1m 02s", "1h 04m": how long it has run. */
function took(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const all = (a: TreeAgent): TreeAgent[] => [a, ...(a.children ?? []).flatMap(all)];
const branchCost = (a: TreeAgent): number | undefined => {
  const kids = (a.children ?? []).map(branchCost).filter((n): n is number => n != null);
  if (a.cost == null && !kids.length) return undefined;
  return (a.cost ?? 0) + kids.reduce((s, n) => s + n, 0);
};
const branchRuns = (a: TreeAgent): boolean => a.status === "running" || (a.children ?? []).some(branchRuns);

const SPARK = (
  <svg className="fi" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2z" fill="currentColor" />
    <path d="M11.4 9.6c.15 1.1.7 1.65 1.8 1.8-1.1.15-1.65.7-1.8 1.8-.15-1.1-.7-1.65-1.8-1.8 1.1-.15 1.65-.7 1.8-1.8z" fill="currentColor" opacity=".55" />
  </svg>
);
const CHEVRON = (
  <svg className="viz-tree-chev fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3.5 4.75L6 7.25l2.5-2.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type Edge = { key: string; d: string; quiet: boolean; delay: number };
type Dot = { key: string; x: number; y: number; quiet: boolean };

export function AgentTree({ root, title = "Agents", icon, collapsed, defaultCollapsed, onCollapsedChange, onSelect, selected = null, onClear, onResolve, answersFor, lead, trail, counts, now, formatCost = money, label, className = "" }: AgentTreeProps) {
  const body = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [width, setWidth] = useState(0);
  const [edges, setEdges] = useState<{ e: Edge[]; dots: Dot[]; w: number; h: number }>({ e: [], dots: [], w: 0, h: 0 });
  const [ownFolded, setOwnFolded] = useState<string[]>(defaultCollapsed ?? []);
  const folded = collapsed ?? ownFolded;
  const [open, setOpen] = useState<string | null>(null);
  const still = useReducedMotion();

  const everyone = useMemo(() => all(root), [root]);
  const running = everyone.filter((a) => a.status === "running").length;
  const waiting = everyone.filter((a) => a.status === "waiting");
  const failed = everyone.filter((a) => a.status === "failed");
  const total = branchCost(root);
  const clock = useTick(now == null && running > 0);
  const at = now ?? clock;

  const isFolded = (id: string) => folded.includes(id);
  const fold = (id: string) => {
    const next = isFolded(id) ? folded.filter((x) => x !== id) : [...folded, id];
    if (collapsed == null) setOwnFolded(next);
    onCollapsedChange?.(next);
  };
  const shown = (a: TreeAgent) => (isFolded(a.id) ? [] : a.children ?? []);

  // What is on screen, depth first: its order staggers the first rise, and its shape tells a change from a resize.
  const visible = useMemo(() => {
    const out: { a: TreeAgent; parent?: TreeAgent; depth: number }[] = [];
    const walk = (a: TreeAgent, depth: number, parent?: TreeAgent) => {
      out.push({ a, parent, depth });
      if (!folded.includes(a.id)) for (const c of a.children ?? []) walk(c, depth + 1, a);
    };
    walk(root, 0);
    return out;
  }, [root, folded]);
  const shape = visible.map((v) => `${v.parent?.id ?? ""}>${v.a.id}`).join("|");

  // New cards rise one after another (90ms apart), each just after its connector starts drawing; the first time, all of them.
  const seen = useRef<Set<string> | null>(null);
  const delays = useMemo(() => {
    const out = new Map<string, number>();
    let i = 0;
    for (const v of visible) if (!seen.current?.has(v.a.id)) out.set(v.a.id, v.parent ? 0.04 + i++ * 0.09 : 0);
    return out;
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    seen.current = new Set(visible.map((v) => v.a.id));
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const fit = () => setWidth(el.clientWidth);
    fit();
    // Drawn in the same frame as the resize: set later, the tree painted one frame in the layout for its old width (a column at the
    // new width's left edge, its trunk a bright line beside the sidebar) whenever the Captain's chat opened or closed (Arun,
    // 2026-11-27: "the flicker happens when i open and close the side chat panel").
    const ro = new ResizeObserver(() => flushSync(fit));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One width for every card: wide, the first-level columns share the row and the deepest level below them still fits; narrow,
  // the deepest level's indent comes off the whole width.
  // Measured from every agent, folded or not, so folding a branch only hides it: nothing else moves or changes size (Arun,
  // 2026-11-27: "shouldn't be moving anything or changing the card in size").
  const firstRow = root.children ?? [];
  const kids = shown(root);
  const depthOf = (a: TreeAgent): number => Math.max(0, ...(a.children ?? []).map((c) => 1 + depthOf(c)));
  const below = Math.max(0, ...firstRow.map(depthOf));
  const n = Math.max(1, firstRow.length);
  // Also narrow when the first level side by side would squeeze each card under SIDE_MIN: five agents beside the Captain's chat
  // ran past the pane both ways, the outer cards cut off, and every name and model clipped to a letter or two.
  const squeezed = width > 0 && (width < 560 || (width - GAP * (n - 1)) / n - INDENT * below < SIDE_MIN);
  // A flat crew that won't fit one row wraps into a centred grid; only a pane too narrow for two cards falls to one column.
  const gridAvail = width - SPINE * 2;
  const grid = squeezed && below === 0 && n > 2 && gridAvail >= GRID_MIN * 2 + GAP;
  const cols = grid ? Math.max(2, Math.min(n, Math.floor((gridAvail + GAP) / (GRID_MIN + GAP)))) : 0;
  const narrow = squeezed && !grid;
  const cardW = !width ? CARD : grid ? Math.min(GRID_MAX, Math.floor((gridAvail - GAP * (cols - 1)) / cols)) : narrow ? Math.max(140, Math.min(NARROW_CARD, width - INDENT * depthOf(root))) : Math.max(140, Math.min(CARD, (width - GAP * (n - 1)) / n - INDENT * below));
  const colW = cardW + INDENT * below;
  // The root sits over the middle of its row's cards; folded (no row under it), in the middle of the pane (it floated off right).
  const rootShift = narrow || grid || kids.length < 2 ? 0 : ((firstRow.length - 1) * (colW + GAP)) / 2;

  // The connectors, from the cards: the root's trunk down to a bus and into each first-level card; an elbow from under a card's
  // avatar (21 in) into each card hanging below it, level with its name (20 down). A parent's dot sits where its lines leave it.
  const measure = () => {
    const el = body.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const rect = (id: string) => {
      const r = cards.current.get(id)?.getBoundingClientRect();
      return r ? { l: r.left - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: r.left - box.left + r.width / 2 } : null;
    };
    const e: Edge[] = [];
    const dots = new Map<string, Dot>();
    if (grid) {
      // The root's trunk down to the first row's bus; a bracket down the grid's left from that bus to each later row's; a drop from
      // each row's bus into each of its cards.
      const top = rect(root.id);
      const firsts = visible.filter((v) => v.depth === 1).map((v) => ({ v, r: rect(v.a.id) })).filter((x): x is { v: (typeof visible)[number]; r: NonNullable<ReturnType<typeof rect>> } => !!x.r);
      if (top && firsts.length) {
        const rows = new Map<number, typeof firsts>();
        for (const x of firsts) {
          const k = [...rows.keys()].find((t) => Math.abs(t - x.r.t) < 4) ?? x.r.t;
          rows.set(k, [...(rows.get(k) ?? []), x]);
        }
        const list = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => ({ y: t - ROW_GAP / 2, xs: xs.sort((a, b) => a.r.cx - b.r.cx) }));
        const spine = Math.min(...firsts.map((x) => x.r.l)) - SPINE / 2 - 1;
        const bus0 = list[0]!.y;
        const busY = (i: number) => (i === 0 ? bus0 : list[i]!.y);
        const q = (xs: typeof firsts) => xs.every((x) => quiet(x.v.a.status));
        e.push({ key: "trunk", d: `M${top.cx} ${top.b} V${bus0}`, quiet: q(firsts), delay: 0 });
        if (list.length > 1) e.push({ key: "spine", d: `M${spine} ${bus0} V${list.at(-1)!.y - R} Q${spine} ${list.at(-1)!.y} ${spine + R} ${list.at(-1)!.y}`, quiet: q(firsts.filter((x) => x.r.t > list[0]!.y + ROW_GAP)), delay: 0.04 });
        list.forEach((row, i) => {
          const y = busY(i);
          const from = i === 0 ? Math.min(row.xs[0]!.r.cx, top.cx, list.length > 1 ? spine : Infinity) : spine + (i === list.length - 1 ? R : 0);
          const to = Math.max(row.xs.at(-1)!.r.cx, i === 0 ? top.cx : -Infinity);
          e.push({ key: `bus${i}`, d: `M${from} ${y} H${to}`, quiet: q(row.xs), delay: 0.04 });
          for (const x of row.xs) e.push({ key: `${root.id}>${x.v.a.id}`, d: `M${x.r.cx} ${y} V${x.r.t}`, quiet: quiet(x.v.a.status), delay: Math.max(0, (delays.get(x.v.a.id) ?? 0.04) - 0.04) });
        });
        dots.set("root", { key: "root", x: top.cx, y: top.b, quiet: q(firsts) });
      }
    }
    for (const v of visible) {
      if (!v.parent || (grid && v.depth === 1)) continue;
      const a = rect(v.parent.id);
      const b = rect(v.a.id);
      if (!a || !b) continue;
      const q = quiet(v.a.status);
      let d: string;
      let x: number;
      if (v.depth === 1 && !narrow) {
        x = a.cx;
        const bus = a.b + (b.t - a.b) / 2;
        const dx = b.cx - a.cx;
        const r = Math.min(R, Math.abs(dx) / 2, b.t - bus);
        d = Math.abs(dx) < 1 ? `M${x} ${a.b} V${b.t}` : `M${x} ${a.b} V${bus - r} Q${x} ${bus} ${x + Math.sign(dx) * r} ${bus} H${b.cx - Math.sign(dx) * r} Q${b.cx} ${bus} ${b.cx} ${bus + r} V${b.t}`;
      } else {
        x = a.l + 21;
        const y = b.t + 20;
        const r = Math.max(0, Math.min(R, b.l - x, y - a.b));
        d = `M${x} ${a.b} V${y - r} Q${x} ${y} ${x + r} ${y} H${b.l}`;
      }
      e.push({ key: `${v.parent.id}>${v.a.id}`, d, quiet: q, delay: Math.max(0, (delays.get(v.a.id) ?? 0.04) - 0.04) });
      const k = `${v.parent.id}@${Math.round(x)}`;
      dots.set(k, { key: k, x, y: a.b, quiet: (dots.get(k)?.quiet ?? true) && q });
    }
    // Sized to the cards, not the body's scroll size: that counted this layer's own last size, so it never shrank after a resize
    // (944px of wires in a 327px pane, a sideways overflow hidden only by the pane's clip).
    let right = el.clientWidth;
    let bottom = 0;
    for (const c of cards.current.values()) {
      const r = c.getBoundingClientRect();
      right = Math.max(right, r.right - box.left);
      bottom = Math.max(bottom, r.bottom - box.top);
    }
    setEdges({ e, dots: [...dots.values()], w: Math.ceil(right), h: Math.ceil(bottom) });
  };

  // FLIP: when the tree changes, each card that moved starts where it was and glides to its new place, its connectors with it.
  const prev = useRef(new Map<string, DOMRect>());
  const prevShape = useRef(shape);
  useLayoutEffect(() => {
    let raf = 0;
    const before = prev.current;
    const after = new Map<string, DOMRect>();
    for (const [id, n] of cards.current) after.set(id, n.getBoundingClientRect());
    let moved = false;
    // Only when the tree itself changed: the pane resizing into or out of a column (a panel beside it opening or closing) moves
    // every card at once, and gliding them across each other, wires and all, read as the page flickering.
    const changed = prevShape.current !== shape;
    prevShape.current = shape;
    if (!still && changed)
      for (const [id, r] of after) {
        const was = before.get(id);
        const node = cards.current.get(id);
        if (!was || !node) continue;
        const dx = was.left - r.left;
        const dy = was.top - r.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        moved = true;
        node.style.transition = "none";
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        node.getBoundingClientRect();
        node.style.transition = "";
        node.style.transform = "";
      }
    prev.current = after;
    measure();
    if (moved) {
      const end = performance.now() + 460;
      const step = () => {
        measure();
        if (performance.now() < end) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    return () => cancelAnimationFrame(raf);
  }, [shape, narrow, grid, cols]); // eslint-disable-line react-hooks/exhaustive-deps

  // A resize, or a card that grows: measure again, with no glide.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const again = () => {
      measure();
      for (const [id, n] of cards.current) prev.current.set(id, n.getBoundingClientRect());
    };
    const ro = new ResizeObserver(again);
    ro.observe(el);
    for (const c of cards.current.values()) ro.observe(c);
    return () => ro.disconnect();
  }, [shape, narrow, grid, cols, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const ref = (id: string) => (n: HTMLElement | null) => void (n ? cards.current.set(id, n) : cards.current.delete(id));
  const card = (a: TreeAgent) => (
    <TreeCard
      a={a}
      now={at}
      formatCost={formatCost}
      delay={delays.get(a.id)}
      folded={isFolded(a.id)}
      onFold={() => fold(a.id)}
      onSelect={onSelect}
      selected={selected === a.id}
      onMove={(dir) => {
        // ←/→ along the cards as they're drawn, the selection with the focus.
        const ids = visible.map((v) => v.a.id);
        const next = visible[Math.max(0, Math.min(ids.length - 1, ids.indexOf(a.id) + dir))]!.a;
        cards.current.get(next.id)?.focus();
        onSelect?.(next, "move");
      }}
      open={open === a.id}
      onOpen={() => setOpen(open === a.id ? null : a.id)}
      onClose={() => setOpen(null)}
      onResolve={onResolve}
      answersFor={answersFor}
      cardRef={ref(a.id)}
    />
  );
  const item = (a: TreeAgent, cls: string, inner?: ReactNode, style?: CSSProperties) => {
    const has = (a.children?.length ?? 0) > 0;
    return (
      <div key={a.id} className={`viz-tree-item ${cls}`} role="treeitem" aria-label={`${a.name}, ${a.word ?? word(a.status)}`} aria-expanded={has ? !isFolded(a.id) : undefined} aria-selected={onSelect ? selected === a.id : undefined} style={style}>
        {card(a)}
        {inner}
      </div>
    );
  };
  const hang = (a: TreeAgent): ReactNode => {
    const c = shown(a);
    return c.length ? (
      <div className="viz-tree-sub" role="group">
        {c.map((g) => item(g, "", hang(g)))}
      </div>
    ) : null;
  };

  // The window behind the header's flag: the first agent that needs you, or the first that failed.
  const flag = (list: TreeAgent[]) => {
    const a = list[0];
    if (!a) return;
    // Unfold every branch on its way, so its card (and its chip, the window's anchor) is on screen.
    const path: string[] = [];
    const find = (x: TreeAgent, trail: string[]): boolean => (x.id === a.id ? (path.push(...trail), true) : (x.children ?? []).some((c) => find(c, [...trail, x.id])));
    find(root, []);
    const hidden = path.filter((id) => folded.includes(id));
    if (hidden.length) {
      const next = folded.filter((id) => !hidden.includes(id));
      if (collapsed == null) setOwnFolded(next);
      onCollapsedChange?.(next);
    }
    setOpen(a.id);
  };

  const nAgents = counts?.agents ?? everyone.length;
  const nRunning = counts?.running ?? running;
  const nWaiting = counts?.waiting ?? waiting.length;
  const summary = [`${nAgents} agent${nAgents === 1 ? "" : "s"}`, nRunning ? `${nRunning} running` : "", nWaiting ? `${nWaiting} need${nWaiting === 1 ? "s" : ""} you` : "", failed.length ? `${failed.length} failed` : ""].filter(Boolean).join(", ");
  return (
    <section className={`viz viz-tree ${className}`} aria-label={label ?? title}>
      <header className="viz-tree-head">
        {lead ?? (
          <>
            <span className="viz-tree-icon">{icon ?? SPARK}</span>
            <span className="viz-tree-title">{title}</span>
          </>
        )}
        <span className="viz-tree-meta">
          <span>
            {nAgents} agent{nAgents === 1 ? "" : "s"}
          </span>
          {nRunning > 0 && <span className="on">{nRunning} running</span>}
          {nWaiting > 0 && (
            <button type="button" className="viz-tree-flag" data-s="needs" onClick={() => flag(waiting)} disabled={!waiting.length}>
              {nWaiting} need{nWaiting === 1 ? "s" : ""} you
              {CHEVRON}
            </button>
          )}
          {failed.length > 0 && (
            <button type="button" className="viz-tree-flag" data-s="failed" onClick={() => flag(failed)}>
              {failed.length} failed
              {CHEVRON}
            </button>
          )}
          {total != null && (
            <Shine on={nRunning > 0} className="viz-tree-total">
              {formatCost(total)}
            </Shine>
          )}
        </span>
        {trail && <span className="viz-tree-trail">{trail}</span>}
        <span className="sr-only" aria-live="polite">
          {summary}
        </span>
      </header>
      <div className="viz-tree-body" data-narrow={narrow || undefined} data-grid={grid || undefined} ref={body} onClick={onClear ? (e) => !(e.target as Element).closest(".viz-tree-card, button, [role=dialog]") && onClear() : undefined} role="tree" aria-label={title} style={{ "--tree-card": `${cardW}px`, "--tree-col": `${colW}px` } as CSSProperties}>
        <svg className="viz-wires" width={edges.w} height={edges.h} aria-hidden="true">
          {edges.e.map((e) => (
            <path key={e.key} className="viz-tree-wire" data-quiet={e.quiet || undefined} d={e.d} pathLength={1} style={{ animationDelay: `${e.delay}s` }} />
          ))}
          {edges.dots.map((d) => (
            <circle key={d.key} className="viz-tree-dot" data-quiet={d.quiet || undefined} cx={d.x} cy={d.y} r={3.25} />
          ))}
        </svg>
        {item(
          root,
          "root",
          kids.length ? (
            narrow ? (
              hang(root)
            ) : grid ? (
              <div className="viz-tree-grid" role="group" style={{ gridTemplateColumns: `repeat(${cols}, ${cardW}px)` }}>
                {kids.map((c) => item(c, "col", hang(c)))}
              </div>
            ) : (
              <div className="viz-tree-row" role="group">
                {kids.map((c) => item(c, "col", hang(c)))}
              </div>
            )
          ) : null,
          narrow ? undefined : ({ "--tree-shift": `${rootShift}px` } as CSSProperties),
        )}
      </div>
    </section>
  );
}

function TreeCard({ a, now, formatCost, delay, folded, onFold, onSelect, selected, onMove, open, onOpen, onClose, onResolve, answersFor, cardRef }: { a: TreeAgent; answersFor?: AgentTreeProps["answersFor"]; now: number; formatCost: (n: number) => string; delay?: number; folded: boolean; onFold: () => void; onSelect?: AgentTreeProps["onSelect"]; selected: boolean; onMove: (dir: -1 | 1) => void; open: boolean; onOpen: () => void; onClose: () => void; onResolve?: (a: TreeAgent, answer: TreeAnswer) => void; cardRef: (n: HTMLElement | null) => void }) {
  const chip = useRef<HTMLButtonElement | null>(null);
  const cost = branchCost(a);
  const climbing = branchRuns(a);
  const n = a.children?.length ?? 0;
  const time = a.started != null ? took((a.ended ?? (a.status === "running" || a.status === "waiting" ? now : a.started)) - a.started) : null;
  const windowed = (a.status === "waiting" && a.ask) || (a.status === "failed" && a.error);
  const words = a.word ? { ...WORDS, [VIZ[a.status]]: a.word } : WORDS;
  const pick = onSelect ? () => onSelect(a, "pick") : undefined;
  const key = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || !pick) return;
    if (e.key === "Enter") (e.preventDefault(), pick());
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") (e.preventDefault(), onMove(e.key === "ArrowRight" ? 1 : -1));
  };
  return (
    <div
      ref={cardRef}
      className="viz-tree-card"
      data-s={a.status}
      data-quiet={quiet(a.status) || undefined}
      data-pick={pick ? "" : undefined}
      data-sel={selected || undefined}
      aria-pressed={pick ? selected : undefined}
      tabIndex={pick ? 0 : undefined}
      onClick={pick}
      onKeyDown={key}
      style={delay != null ? { animationDelay: `${delay}s` } : { animation: "none" }}
    >
      <div className="viz-tree-r1">
        <Tile size={22}>{a.avatar ?? <PixelMark seed={a.name} color={colorOf(a.name)} working={a.status === "running"} />}</Tile>
        <span className="viz-nm">
          <span className="viz-name">{a.name}</span>
          {a.model && (
            <span className="viz-model">
              {a.modelMark && <span className="viz-model-mark">{a.modelMark}</span>}
              {a.model}
            </span>
          )}
        </span>
        {windowed ? (
          <button
            type="button"
            ref={chip}
            className="viz-tree-chipbtn"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`${a.word ?? word(a.status)}: ${a.name}`}
            onClick={(e) => (e.stopPropagation(), onOpen())}
          >
            <VizChip status={VIZ[a.status]} words={words} />
          </button>
        ) : (
          <VizChip status={VIZ[a.status]} words={words} />
        )}
      </div>
      {a.role && (
        <p className="viz-tree-role" title={a.role}>
          {a.role}
        </p>
      )}
      <p className="viz-tree-task">
        {a.tools && a.tools.length > 0 && <ToolRow tools={a.tools} stacked />}
        {a.task}
      </p>
      <div className="viz-tree-foot">
        <span className="viz-tree-cost">
          {cost != null && (
            <Shine on={climbing} className="viz-tree-usd">
              {formatCost(cost)}
            </Shine>
          )}
          {time && <span className="viz-tree-time">{cost != null ? ` · ${time}` : time}</span>}
        </span>
        {n > 0 && (
          <button type="button" className="viz-tree-fold" data-folded={folded || undefined} aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${n} sub-agent${n === 1 ? "" : "s"} of ${a.name}`} onClick={(e) => (e.stopPropagation(), onFold())}>
            {n}
            {CHEVRON}
          </button>
        )}
      </div>
      {windowed && (
        <Popover open={open} onClose={onClose} anchor={chip} side="bottom" align="end" width={260} unstyled className="viz viz-pop" aria-label={`${a.name}: ${word(a.status)}`}>
          <div className="viz-pop-in viz-tree-win" onClick={(e) => e.stopPropagation()}>
            <div className="viz-pop-head">
              <VizChip status={VIZ[a.status]} words={words} />
              <span className="viz-tree-win-name">{a.name}</span>
            </div>
            <div className="viz-pop-well">
              <p>{a.status === "waiting" ? a.ask : a.error}</p>
            </div>
            <div className="viz-pop-acts">
              {(answersFor?.(a) ?? (a.status === "waiting" ? (["approve", "reject"] as const) : (["retry", "dismiss"] as const)).map((x) => ({ answer: x, label: x[0]!.toUpperCase() + x.slice(1) }))).map((x, i) => (
                <button key={x.answer} type="button" className={i === 0 ? "viz-btn primary" : "viz-btn"} onClick={() => (onClose(), onResolve?.(a, x.answer))}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
