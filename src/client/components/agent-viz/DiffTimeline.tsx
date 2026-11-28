// Diff Timeline (affectUI Pro, rebuilt by hand from its public preview; SPEC diff-timeline): what an agent changed in a pull
// request, edit by edit. Lines added and removed climb as two lines over one time axis (the net dashed between them), each file
// gets a row with one bar of all it added and removed, and every edit's diff opens on hover or with the arrow keys. The scales
// come from all the edits, so nothing rescales while a run plays; `elapsed` only decides how much of it shows.
//
// Past the original (Arun, 2026-11-27: "i want people to understand what was changed"): a file row opens that file's edits, each
// with its diff, and lights only its steps on the chart; a step clicked on the chart pins its diff. A long run with idle gaps (a
// thread over days) folds each gap to a short break on the axis, so its bursts read instead of a flat line; and `fill` lets the
// card take its pane's whole height, the file list getting the room.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { PixelMark, colorOf, useReducedMotion } from "./viz-parts.js";
import "./agent-viz.css";
import "./diff-timeline.css";

export interface DiffEdit {
  /** Seconds since the run started. */
  at: number;
  /** The file's path: "components/hero.tsx". Its folder is drawn muted. */
  file: string;
  added: number;
  removed: number;
  /** The changed lines, each starting with "+", "-" or " ", for the edit's popover. */
  diff?: string[];
  /** A file with no lines to count (an image): its row says "binary". */
  binary?: boolean;
  /** Who made it, when one timeline shows several agents' work (the whole crew's): its popover names them. */
  by?: string;
}

export interface DiffTimelineProps {
  /** The agent: its id gives it its own pixel mark. */
  agent: { id: string; name: string };
  /** Quiet text after the name: "PR #214". */
  context?: string;
  edits: DiffEdit[];
  /** Seconds since the run started; later edits stay hidden. Default: the last edit. */
  elapsed?: number;
  /** Still writing: the mark twinkles, the line ends glow and the status line names the file. */
  live?: boolean;
  /** Length of the time axis in seconds. Default: the run, rounded up to a minute. */
  duration?: number;
  /** File rows before the list scrolls; the card keeps one height however many files the run touches. */
  maxRows?: number;
  /** When the run started (ms since 1970): times then read as the clock ("2:14 PM", "Mon 3 PM") rather than from zero. */
  startedAt?: number;
  /** The project's folder: paths under it read from it; anything else reads as outside the project (home as ~). */
  root?: string;
  /** Take the parent's whole height: the chart grows a little and the file list takes the rest instead of scrolling at `maxRows`. */
  fill?: boolean;
  className?: string;
}

const BASE_H = 156;
const ROW_H = 30;
/** How long a step takes to climb, in seconds of axis, ending at its edit's time (at least 1.5% of the axis, so it reads). */
const RAMP = 5;
const POP_W = 248;
/** A pinned popover is wider, for whole diff lines. */
const PIN_W = 340;
const MINUS = "−";
const HOUR = 3600;
const DAY = 86400;

/** 1, 2, 2.5 or 5 times a power of ten: the y axis step, so four of them clear the run's biggest total. */
function niceStep(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const pad = (n: number) => String(n).padStart(2, "0");
/** A time into the run, as exact as the run is long: "3:27" under an hour, "4:05:12" under a day, then "2d 4:05". */
function sinceStart(s: number, span: number): string {
  const t = Math.max(0, Math.round(s));
  if (span < HOUR) return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / 60);
  if (span < DAY) return `${h}:${pad(m)}:${pad(t % 60)}`;
  return d ? `${d}d ${h}:${pad(m)}` : `${h}:${pad(m)}`;
}
/** An axis label: "3:00" under an hour, "4:05" (h:mm) under a day, then "2d 4h". */
function axisWords(s: number, span: number): string {
  const t = Math.max(0, Math.round(s));
  if (span < HOUR) return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  if (span < DAY) return `${Math.floor(t / HOUR)}:${pad(Math.floor((t % HOUR) / 60))}`;
  const d = Math.floor(t / DAY);
  const h = Math.floor((t % DAY) / HOUR);
  return d ? `${d}d ${h}h` : `${h}h`;
}
/** How long, in words: "3:27", "4h 05m", "11d 6h". */
function lengthWords(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < HOUR) return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  if (t < DAY) return `${Math.floor(t / HOUR)}h ${pad(Math.floor((t % HOUR) / 60))}m`;
  return `${Math.floor(t / DAY)}d ${Math.floor((t % DAY) / HOUR)}h`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function wall(ms: number, withDay: boolean, hourOnly = false): string {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const ap = d.getHours() < 12 ? "AM" : "PM";
  const time = hourOnly ? `${h} ${ap}` : `${h}:${pad(d.getMinutes())} ${ap}`;
  return withDay ? `${DAYS[d.getDay()]} ${time}` : time;
}
/** "4.8k" for 4,812, as a narrow card counts. */
const short = (n: number) => (n >= 1000 ? `${(Math.round(n / 100) / 10).toString()}k` : String(n));
const split = (path: string) => {
  const i = path.lastIndexOf("/");
  return { folder: i >= 0 ? path.slice(0, i + 1) : "", name: i >= 0 ? path.slice(i + 1) : path };
};
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const ease = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));
const isBinary = (e: DiffEdit) => e.binary ?? (e.added === 0 && e.removed === 0);

/** A path as the card says it: from the project's folder when under it; else outside it, home as ~. */
function placeOf(path: string, root?: string): { shown: string; outside: boolean } {
  const r = root?.replace(/\/+$/, "");
  if (r && path.startsWith(`${r}/`)) return { shown: path.slice(r.length + 1), outside: false };
  if (path.startsWith("/") || path.startsWith("~")) return { shown: path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~"), outside: true };
  return { shown: path, outside: false };
}

/**
 * The axis: real seconds to axis seconds. An idle gap much longer than the run's bursts folds to a short break, so a run over
 * days shows its work rather than a flat line; a run with no such gap maps straight across.
 */
interface Axis {
  len: number;
  segs: { r0: number; r1: number; v0: number; v1: number; folded: boolean }[];
}
function axisOf(times: number[], dur: number): Axis {
  const straight = { len: dur, segs: [{ r0: 0, r1: dur, v0: 0, v1: dur, folded: false }] };
  if (dur <= 2 * HOUR || !times.length) return straight;
  const gap = Math.max(20 * 60, dur * 0.03);
  const pts = [0, ...times, dur];
  // First the gaps to fold, each keeping a sliver at either end so the step into the next burst still climbs.
  const folds: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (b - a <= gap) continue;
    const keep = Math.min(gap / 4, (b - a) / 8);
    folds.push([a + keep, b - keep]);
  }
  if (!folds.length) return straight;
  // Then how wide a break is: together the breaks take at most a fifth of the axis, so the bursts get the room.
  const active = dur - folds.reduce((n, [a, b]) => n + b - a, 0);
  const each = Math.min(gap / 2, (active * 0.25) / folds.length);
  const segs: Axis["segs"] = [];
  let v = 0;
  let r = 0;
  for (const [f0, f1] of folds) {
    if (f0 > r) segs.push({ r0: r, r1: f0, v0: v, v1: (v += f0 - r), folded: false });
    segs.push({ r0: f0, r1: f1, v0: v, v1: (v += each), folded: true });
    r = f1;
  }
  if (dur > r) segs.push({ r0: r, r1: dur, v0: v, v1: (v += dur - r), folded: false });
  return { len: v, segs };
}
function warp(ax: Axis, t: number): number {
  for (const s of ax.segs) if (t <= s.r1) return s.v0 + ((Math.max(t, s.r0) - s.r0) / Math.max(s.r1 - s.r0, 1e-9)) * (s.v1 - s.v0);
  return ax.len;
}

/** A file's page in its kind's colour: blue for code, pink for an image. */
function FileIcon({ path }: { path: string }) {
  return (
    <svg className="dtl-ic fi" data-k={IMAGE.test(path) ? "image" : "code"} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3.6 1.5h4.3L11 4.6v7a.9.9 0 0 1-.9.9H3.6a.9.9 0 0 1-.9-.9V2.4a.9.9 0 0 1 .9-.9z" fill="currentColor" />
      <path d="M7.9 1.5v2.4a.7.7 0 0 0 .7.7H11" fill="none" stroke="var(--dtl-ic-line)" />
      <path d="M4.6 7.6h3.2M4.6 9.6h4.6" stroke="var(--dtl-ic-line)" strokeLinecap="round" />
    </svg>
  );
}

function Path({ path, folders = true }: { path: string; folders?: boolean }) {
  const { folder, name } = split(path);
  return (
    <>
      {folders && folder && <span className="dtl-folder">{folder}</span>}
      <span className="dtl-file">{name}</span>
    </>
  );
}

function Counts({ added, removed, narrow, binary }: { added: number; removed: number; narrow: boolean; binary?: boolean }) {
  if (binary) return <span className="dtl-counts"><span className="dtl-bin">binary</span></span>;
  const f = narrow ? short : String;
  return (
    <span className="dtl-counts">
      <span className={added ? "dtl-add" : "dtl-zero"}>+{f(added)}</span>
      <span className={removed ? "dtl-del" : "dtl-zero"}>{MINUS}{f(removed)}</span>
    </span>
  );
}

/** An edit's changed lines in mono, red and green on their own tints; `max` lines, then how many more. */
function DiffLines({ lines, max }: { lines?: string[]; max?: number }) {
  if (!lines?.length) return null;
  const shown = max ? lines.slice(0, max) : lines;
  return (
    <div className="dtl-diff">
      {shown.map((l, i) => (
        <div key={i} className={l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}>
          <span className="dtl-sign">{l[0] === "+" ? "+" : l[0] === "-" ? MINUS : " "}</span>
          {l.slice(1) || " "}
        </div>
      ))}
      {max && lines.length > max && <div className="dtl-more">{lines.length - max} more lines</div>}
    </div>
  );
}

type FileRow = { path: string; shown: string; outside: boolean; added: number; removed: number; edits: DiffEdit[]; binary: boolean };

export function DiffTimeline({ agent, context, edits, elapsed, live = false, duration, maxRows = 7, startedAt, root, fill = false, className = "" }: DiffTimelineProps) {
  const card = useRef<HTMLElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [cardH, setCardH] = useState(0);
  const [narrow, setNarrow] = useState(false);
  // What's open: `open` follows the pointer or the arrow keys; `pin` stays until Esc or a click elsewhere; `sel` is a chosen file.
  const [open, setOpen] = useState<DiffEdit | null>(null);
  const [pin, setPin] = useState<DiffEdit | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hoverFile, setHoverFile] = useState<string | null>(null);
  const still = useReducedMotion();
  const gid = useId().replace(/[^a-zA-Z0-9-]/g, "");

  // Lines stay crisp at any width: the chart is drawn in the plot's own pixels, measured, never stretched.
  useLayoutEffect(() => {
    const read = () => {
      if (plot.current) setW(plot.current.clientWidth);
      if (card.current) {
        setNarrow(card.current.clientWidth < 440);
        setCardH(card.current.clientHeight);
      }
    };
    read();
    const ro = new ResizeObserver(read);
    if (card.current) ro.observe(card.current);
    if (plot.current) ro.observe(plot.current);
    return () => ro.disconnect();
  }, []);
  // Filling a tall pane, the chart grows with it (to 300px) and the list takes the rest.
  const H = fill && cardH ? Math.round(Math.min(300, Math.max(BASE_H, cardH * 0.3))) : BASE_H;

  // Everything that sets a scale comes from all the edits, so playback never rescales the chart or the bars.
  const all = useMemo(() => [...edits].sort((a, b) => a.at - b.at), [edits]);
  const scale = useMemo(() => {
    const last = all.length ? all[all.length - 1]!.at : 0;
    const unit = last < HOUR ? 60 : last < DAY ? 600 : HOUR;
    const dur = duration ?? Math.max(60, Math.ceil(last / unit) * unit);
    const ax = axisOf(all.map((e) => e.at), dur);
    let add = 0;
    let del = 0;
    const churn = new Map<string, number>();
    for (const e of all) {
      add += e.added;
      del += e.removed;
      churn.set(e.file, (churn.get(e.file) ?? 0) + e.added + e.removed);
    }
    const step = niceStep(Math.max(add, del, 1) / 4);
    // Each step on the axis: where it starts climbing and where it lands, never before the edit ahead of it.
    const ramp = Math.max(RAMP, ax.len * 0.015);
    const lands = all.map((e) => warp(ax, e.at));
    const starts = lands.map((v, i) => Math.max(0, i ? lands[i - 1]! : 0, v - ramp));
    return { dur, ax, top: step * 4, step, maxChurn: Math.max(1, ...churn.values()), last, lands, starts };
  }, [all, duration]);

  const now = Math.min(Math.max(0, elapsed ?? scale.last), scale.dur);
  const vNow = warp(scale.ax, now);
  const shown = useMemo(() => all.filter((e) => e.at <= now), [all, now]);
  const totals = useMemo(() => shown.reduce((t, e) => ({ add: t.add + e.added, del: t.del + e.removed }), { add: 0, del: 0 }), [shown]);
  const span = scale.dur;
  /** An edit's time: the clock when the run's start is known, else from zero. */
  const timeOf = (s: number) => (startedAt != null ? wall(startedAt + s * 1000, span >= DAY || new Date(startedAt).getDate() !== new Date(startedAt + span * 1000).getDate()) : sinceStart(s, span));

  // Files in the order the agent first touched them, each with its edits for its detail. Many files sort by most changed
  // so the big ones lead; files outside the project go last, quieter, under their own label.
  const rows = useMemo(() => {
    const m = new Map<string, FileRow>();
    for (const e of shown) {
      const f = m.get(e.file) ?? { ...placeOf(e.file, root), path: e.file, added: 0, removed: 0, edits: [], binary: true };
      f.added += e.added;
      f.removed += e.removed;
      f.edits.push(e);
      f.binary = f.binary && isBinary(e);
      m.set(e.file, f);
    }
    let list = [...m.values()];
    if (list.length > maxRows) list = list.sort((a, b) => b.added + b.removed - (a.added + a.removed));
    const inside = list.filter((f) => !f.outside);
    const outside = list.filter((f) => f.outside);
    return { inside, outside, count: list.length, all: [...inside, ...outside] };
  }, [shown, root, maxRows]);
  const current = shown.length ? shown[shown.length - 1]! : null;
  const currentRow = current ? (() => {
    const i = rows.inside.findIndex((f) => f.path === current.file);
    if (i >= 0) return i;
    const o = rows.outside.findIndex((f) => f.path === current.file);
    return o < 0 ? -1 : rows.inside.length + 1 + o;
  })() : -1;
  const selRow = sel ? rows.all.find((f) => f.path === sel) ?? null : null;

  // What the popover shows: the pinned edit, else the one under the pointer or the keys. Edits that playback hides fall away.
  const pinned = pin && pin.at <= now ? pin : null;
  const hovered = open && open.at <= now ? open : null;
  const openEdit = pinned ?? hovered;

  // The lines: each total at a point on the axis, every edit climbing over its ramp, sampled per pixel so the curve reads smooth.
  const valueAt = (v: number, pick: (e: DiffEdit) => number) => {
    let sum = 0;
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      if (e.at > now) break;
      const s = scale.starts[i]!;
      const l = scale.lands[i]!;
      sum += pick(e) * (l <= s ? (v >= l ? 1 : 0) : ease((v - s) / (l - s)));
    }
    return sum;
  };
  const xv = (v: number) => (v / scale.ax.len) * w;
  const x = (t: number) => xv(warp(scale.ax, t));
  const y = (val: number) => H - (Math.min(Math.max(val, 0), scale.top) / scale.top) * H;
  const lines = useMemo(() => {
    if (!w) return null;
    const end = xv(vNow);
    const add: string[] = [];
    const del: string[] = [];
    const net: string[] = [];
    for (let px = 0; ; px = Math.min(px + 1, end)) {
      const v = (px / w) * scale.ax.len;
      const a = valueAt(v, (e) => e.added);
      const r = valueAt(v, (e) => e.removed);
      add.push(`${px.toFixed(1)},${y(a).toFixed(2)}`);
      del.push(`${px.toFixed(1)},${y(r).toFixed(2)}`);
      net.push(`${px.toFixed(1)},${y(a - r).toFixed(2)}`);
      if (px >= end) break;
    }
    const base = `L${end.toFixed(1)},${H} L0,${H} Z`;
    return { add: `M${add.join(" L")}`, del: `M${del.join(" L")}`, net: `M${net.join(" L")}`, addFill: `M${add.join(" L")} ${base}`, delFill: `M${del.join(" L")} ${base}`, end };
  }, [w, H, vNow, all, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The run's totals once an edit landed. */
  const totalsAt = (e: DiffEdit) => {
    let add = 0;
    let del = 0;
    for (const o of all) {
      if (o.at > e.at) break;
      add += o.added;
      del += o.removed;
    }
    return { add, del };
  };

  const yTicks = [0, 1, 2, 3, 4].map((i) => i * scale.step);
  // Time labels: whole steps on a straight axis; on a folded one, the start, each burst after a break, and the end, none crowding.
  const xTicks = useMemo(() => {
    const words = (t: number) => (startedAt != null && span >= DAY ? wall(startedAt + t * 1000, true, true) : axisWords(t, span));
    const folded = scale.ax.segs.some((s) => s.folded);
    let ts: number[];
    if (!folded) {
      const fit = Math.max(2, Math.min(6, Math.floor((w || 520) / 70)));
      const steps = [60, 120, 300, 600, 900, 1800, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
      const step = steps.find((s) => span / s <= fit) ?? Math.ceil(span / fit / DAY) * DAY;
      ts = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);
    } else ts = [0, ...scale.ax.segs.filter((s, i) => i > 0 && scale.ax.segs[i - 1]!.folded && !s.folded).map((s) => s.r0), span];
    const out: { t: number; text: string; edge?: "start" | "end" }[] = [];
    for (const t of ts) {
      const px = x(t);
      const edge = t === 0 ? "start" : t >= span ? "end" : undefined;
      // Labels need about 72px between centres; the first sits left of its tick and the last right of it, so they need more.
      const room = (prev: (typeof out)[number]) => 72 + (prev.edge === "start" && prev.text.length > 5 ? 28 : 0) + (edge === "end" && prev.text.length > 5 ? 28 : 0);
      if (edge === "end") while (out.length > 1 && px - x(out[out.length - 1]!.t) < room(out[out.length - 1]!)) out.pop();
      else if (out.length && px - x(out[out.length - 1]!.t) < room(out[out.length - 1]!)) continue;
      out.push({ t, text: words(t), ...(edge ? { edge } : {}) });
    }
    return out;
  }, [scale, w, span, startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // The keys and the pointer step through the edits (only the chosen file's while one is chosen).
  const nav = sel ? shown.filter((e) => e.file === sel) : shown;
  const nearest = (clientX: number) => {
    if (!plot.current) return null;
    const r = plot.current.getBoundingClientRect();
    const px = clientX - r.left;
    let best: DiffEdit | null = null;
    let d = Infinity;
    for (const e of nav) {
      const dd = Math.abs(x(e.at) - px);
      if (dd < d) [best, d] = [e, dd];
    }
    return d > 24 ? null : best;
  };
  const onMove = (ev: PointerEvent<HTMLDivElement>) => {
    if (ev.pointerType === "touch" || (ev.target as HTMLElement).closest(".dtl-pop")) return;
    setOpen(nearest(ev.clientX));
  };
  const onChartClick = (ev: MouseEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest(".dtl-pop")) return;
    const e = nearest(ev.clientX);
    setPin(e && e !== pinned ? e : null);
  };
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!nav.length) return;
    const lastI = nav.length - 1;
    const at = openEdit ? nav.indexOf(openEdit) : -1;
    const go = (i: number) => {
      ev.preventDefault();
      setPin(null);
      setOpen(nav[Math.min(Math.max(i, 0), lastI)]!);
    };
    if (ev.key === "ArrowRight") go(at < 0 ? 0 : at + 1);
    else if (ev.key === "ArrowLeft") go(at < 0 ? lastI : at - 1);
    else if (ev.key === "Home") go(0);
    else if (ev.key === "End") go(lastI);
    else if ((ev.key === "Enter" || ev.key === " ") && openEdit) {
      ev.preventDefault();
      setPin(pinned ? null : openEdit);
    }
  };
  // Esc closes what's open, the innermost first: a pinned or open edit, then the chosen file.
  const onCardKey = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key !== "Escape") return;
    if (pinned || hovered) {
      setPin(null);
      setOpen(null);
    } else if (sel) setSel(null);
    else return;
    ev.preventDefault();
  };
  // A click anywhere but the chart or the popover lets a pinned edit go.
  useEffect(() => {
    if (!pinned) return;
    const down = (ev: globalThis.PointerEvent) => {
      const t = ev.target as HTMLElement;
      if (!t.closest?.(".dtl-plot, .dtl-dedit")) setPin(null);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [pinned]);
  const choose = (path: string) => {
    setSel((s) => (s === path ? null : path));
    setPin(null);
    setOpen(null);
  };

  // The popover keeps the last edit it showed while it fades out.
  const [popEdit, setPopEdit] = useState<DiffEdit | null>(null);
  useEffect(() => {
    if (openEdit) setPopEdit(openEdit);
  }, [openEdit]);
  const pe = openEdit ?? popEdit;
  const peX = pe ? x(pe.at) : 0;
  const popW = pinned ? PIN_W : POP_W;
  const popLeft = pe ? (peX + 12 + popW <= w ? peX + 12 : Math.max(0, peX - 12 - popW)) : 0;
  const peTotals = pe ? totalsAt(pe) : null;

  const net = totals.add - totals.del;
  const across = `across ${rows.count} ${rows.count === 1 ? "file" : "files"}`;
  const color = colorOf(agent.id);
  const marked = hoverFile ?? sel;
  const markEdits = marked ? shown.filter((e) => e.file === marked) : [];
  const dot = (cls: string, cx: number, cy: number) => <span className={`dtl-dot ${cls}`} style={{ left: cx, top: cy }} aria-hidden="true" />;
  const shownPath = (p: string) => placeOf(p, root).shown;

  const fileLi = (f: FileRow) => {
    const churn = f.added + f.removed;
    return (
      <li
        key={f.path}
        data-on={hoverFile === f.path || undefined}
        data-out={f.outside || undefined}
        role="button"
        tabIndex={0}
        aria-pressed={sel === f.path}
        aria-label={`${f.shown}: ${f.binary ? "binary" : `${f.added} added, ${f.removed} removed`}, ${f.edits.length} ${f.edits.length === 1 ? "edit" : "edits"}. Open its edits.`}
        onPointerEnter={() => setHoverFile(f.path)}
        onClick={() => choose(f.path)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            choose(f.path);
          }
        }}
      >
        <FileIcon path={f.path} />
        <span className="dtl-path" title={f.shown}>
          <Path path={f.shown} folders={!narrow} />
        </span>
        <span className="dtl-barcell">
          {f.binary ? (
            <span className="dtl-bar">
              <i className="dtl-binbit" />
            </span>
          ) : (
            <span className="dtl-bar" style={{ width: `${(churn / scale.maxChurn) * 100}%` }}>
              {/* One solid bar per file: all it added, then all it removed. The edit by edit story is in its detail. */}
              <span className="dtl-piece">
                {f.added > 0 && <i className="a" style={{ flexGrow: f.added }} />}
                {f.removed > 0 && <i className="r" style={{ flexGrow: f.removed }} />}
              </span>
            </span>
          )}
        </span>
        <Counts added={f.added} removed={f.removed} narrow={narrow} binary={f.binary} />
      </li>
    );
  };

  return (
    <section
      ref={card}
      className={`viz dtl ${className}`}
      data-narrow={narrow || undefined}
      data-live={live || undefined}
      data-still={still || undefined}
      data-fill={fill || undefined}
      style={{ "--rows": maxRows } as CSSProperties}
      aria-label={`${agent.name}${context ? `, ${context}` : ""}: what it changed`}
      onKeyDown={onCardKey}
    >
      <header className="dtl-head">
        <span className="dtl-mark">
          <PixelMark seed={agent.id} color={color} working={live && !still} />
        </span>
        <span className="dtl-who">
          <span className="dtl-l1">
            <span className="dtl-name">{agent.name}</span>
            {context && <span className="dtl-ctx">&nbsp;· {context}</span>}
          </span>
          <span className="dtl-status" role="status">
            {live && current ? (
              <>
                Editing <Path path={shownPath(current.file)} />
              </>
            ) : shown.length ? (
              `${shown.length} ${shown.length === 1 ? "edit" : "edits"} ${current!.at < DAY ? "in" : "over"} ${lengthWords(current!.at)}`
            ) : (
              "No edits yet"
            )}
          </span>
        </span>
        <p className="dtl-totals">
          <span className="dtl-chip add">+{narrow ? short(totals.add) : totals.add}</span>
          <span className="dtl-chip del">{MINUS}{narrow ? short(totals.del) : totals.del}</span>
          <span className="dtl-across">{across}</span>
        </p>
      </header>

      <div className="dtl-chart">
        <div className="dtl-y" style={{ height: H }} aria-hidden="true">
          {yTicks.map((v) => (
            <span key={v} style={{ top: y(v) - 8 }}>
              {narrow ? short(v) : v}
            </span>
          ))}
        </div>
        <div
          ref={plot}
          className="dtl-plot"
          style={{ height: H + 24 }}
          data-sel={sel ? "" : undefined}
          data-pinned={pinned ? "" : undefined}
          role="group"
          tabIndex={0}
          aria-roledescription="chart"
          aria-label={`Lines added and removed over time, ${nav.length} ${nav.length === 1 ? "edit" : "edits"}${selRow ? ` to ${selRow.shown}` : ""}. Left and right arrows step through the edits, Enter keeps one open.`}
          onPointerMove={onMove}
          onPointerLeave={() => setOpen(null)}
          onClick={onChartClick}
          onKeyDown={onKey}
          onBlur={(ev) => !ev.currentTarget.contains(ev.relatedTarget as Node) && setOpen(null)}
        >
          {w > 0 && lines && (
            <svg className="dtl-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
              <defs>
                <linearGradient id={`${gid}a`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--dtl-add-line)" stopOpacity=".16" />
                  <stop offset="1" stopColor="var(--dtl-add-line)" stopOpacity=".02" />
                </linearGradient>
                <linearGradient id={`${gid}d`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--dtl-del-line)" stopOpacity=".12" />
                  <stop offset="1" stopColor="var(--dtl-del-line)" stopOpacity=".01" />
                </linearGradient>
              </defs>
              {/* A folded idle gap: a faint band and a break on the baseline. */}
              {scale.ax.segs.filter((s) => s.folded).map((s) => {
                const a = xv(s.v0);
                const b = xv(s.v1);
                const m = Math.round((a + b) / 2);
                return (
                  <g key={s.r0} className="dtl-fold">
                    <rect x={a} y={0} width={Math.max(b - a, 1)} height={H} />
                    <path d={`M${m - 4},${H + 3} L${m - 1},${H - 3} M${m + 1},${H + 3} L${m + 4},${H - 3}`} />
                  </g>
                );
              })}
              {yTicks.slice(1).map((v) => (
                <line key={v} className="dtl-grid" x1="0" x2={w} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
              ))}
              <line className="dtl-base" x1="0" x2={w} y1={H - 0.5} y2={H - 0.5} />
              <line className="dtl-now" x1={Math.round(lines.end) + 0.5} x2={Math.round(lines.end) + 0.5} y1="0" y2={H} />
              <g className="dtl-lines">
                <path d={lines.addFill} fill={`url(#${gid}a)`} />
                <path d={lines.delFill} fill={`url(#${gid}d)`} />
                <path className="dtl-net" d={lines.net} />
                <path className="dtl-ln del" d={lines.del} />
                <path className="dtl-ln add" d={lines.add} />
              </g>
              {/* The chosen file's edits: a stem from the baseline to where the added line stood once each landed. */}
              {sel &&
                markEdits.map((e, i) => {
                  const ex = Math.round(x(e.at)) + 0.5;
                  return <line key={i} className={`dtl-stem ${e.added >= e.removed ? "add" : "del"}`} x1={ex} x2={ex} y1={y(totalsAt(e).add)} y2={H} />;
                })}
              {openEdit && <line className={pinned ? "dtl-guide pinned" : "dtl-guide"} x1={Math.round(x(openEdit.at)) + 0.5} x2={Math.round(x(openEdit.at)) + 0.5} y1="0" y2={H} />}
            </svg>
          )}
          {w > 0 && lines && (
            <>
              {dot("net", lines.end, y(totals.add - totals.del))}
              {dot("del", lines.end, y(totals.del))}
              {dot("add", lines.end, y(totals.add))}
              {sel && markEdits.map((e, i) => <span key={`s${i}`} className={`dtl-dot at sm ${e.added >= e.removed ? "add" : "del"}`} style={{ left: x(e.at), top: y(totalsAt(e).add) }} aria-hidden="true" />)}
              {openEdit && peTotals && (
                <>
                  {dot("del at", x(openEdit.at), y(peTotals.del))}
                  {dot("add at", x(openEdit.at), y(peTotals.add))}
                </>
              )}
              {markEdits.map((e, i) => (
                <span key={i} className={`dtl-mark-e ${e.added >= e.removed ? "add" : "del"}`} style={{ left: x(e.at), top: H }} aria-hidden="true" />
              ))}
            </>
          )}
          <div className="dtl-x" style={{ top: H + 6 }} aria-hidden="true">
            {xTicks.map((t) => (
              <span key={t.t} data-edge={t.edge} style={{ left: w ? x(t.t) : `${(t.t / span) * 100}%` }}>
                {t.text}
              </span>
            ))}
          </div>
          <div className="dtl-pop" data-open={openEdit ? "" : undefined} data-pinned={pinned ? "" : undefined} style={{ left: popLeft }} aria-live="polite" aria-hidden={openEdit ? undefined : true}>
            {pe && peTotals && (
              <>
                <div className="dtl-pop-h">
                  <span className="dtl-pop-f" title={shownPath(pe.file)}>
                    <Path path={shownPath(pe.file)} />
                  </span>
                  {pe.by && <span className="dtl-pop-by">{pe.by}</span>}
                  <span className="dtl-pop-t">{timeOf(pe.at)}</span>
                </div>
                <div className="dtl-pop-n">
                  {isBinary(pe) ? (
                    <span className="dtl-bin">binary</span>
                  ) : (
                    <>
                      <span className="dtl-add">+{pe.added}</span>
                      <span className="dtl-del">{MINUS}{pe.removed}</span>
                    </>
                  )}
                  <span className="dtl-pop-run">
                    run at +{peTotals.add} {MINUS}{peTotals.del}
                  </span>
                </div>
                <DiffLines lines={pe.diff} {...(pinned ? {} : { max: 8 })} />
                {!pinned && <div className="dtl-pop-hint">Click to keep it open</div>}
              </>
            )}
          </div>
        </div>
      </div>

      {selRow ? (
        <FileDetail
          f={selRow}
          narrow={narrow}
          timeOf={timeOf}
          pinned={pinned}
          onBack={() => choose(selRow.path)}
          onPick={(e) => {
            setOpen(null);
            setPin(pinned === e ? null : e);
          }}
        />
      ) : (
        <ul className="dtl-files" data-dim={hoverFile ? "" : undefined} onPointerLeave={() => setHoverFile(null)}>
          {live && currentRow >= 0 && <span className="dtl-wash" style={{ transform: `translateY(${currentRow * ROW_H}px)` }} aria-hidden="true" />}
          {rows.inside.map(fileLi)}
          {rows.outside.length > 0 && (
            <li className="dtl-group" aria-hidden="true">
              Outside the project · {rows.outside.length}
            </li>
          )}
          {rows.outside.map(fileLi)}
        </ul>
      )}

      <footer className="dtl-legend">
        <span>
          <i className="dtl-sw add" />
          Added
        </span>
        <span>
          <i className="dtl-sw del" />
          Removed
        </span>
        <span>
          <i className="dtl-sw net" />
          Net <b>{net >= 0 ? "+" : MINUS}{Math.abs(net)}</b>
        </span>
      </footer>
    </section>
  );
}

/** A chosen file: its edits in time order, each with its time, its counts and its changed lines; one pressed pins it on the chart. */
function FileDetail({ f, narrow, timeOf, pinned, onBack, onPick }: { f: FileRow; narrow: boolean; timeOf: (s: number) => string; pinned: DiffEdit | null; onBack: () => void; onPick: (e: DiffEdit) => void }) {
  const first = f.edits[0]!;
  const last = f.edits[f.edits.length - 1]!;
  const n = f.edits.length;
  return (
    <div className="dtl-detail">
      <div className="dtl-dhead">
        <button type="button" className="dtl-back" onClick={onBack}>
          <svg className="fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.5 3L4.5 6l3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All files
        </button>
        <FileIcon path={f.path} />
        <span className="dtl-path" title={f.shown}>
          <Path path={f.shown} folders={!narrow} />
        </span>
        <Counts added={f.added} removed={f.removed} narrow={narrow} binary={f.binary} />
      </div>
      <p className="dtl-dsum">
        {n} {n === 1 ? "edit" : "edits"}
        {!f.binary && (
          <>
            {" · "}
            <span className="dtl-add">+{f.added}</span> <span className="dtl-del">{MINUS}{f.removed}</span>
          </>
        )}
        {" · "}first {timeOf(first.at)}
        {n > 1 && ` · last ${timeOf(last.at)}`}
      </p>
      <ol className="dtl-dedits">
        {f.edits.map((e, i) => (
          <li key={i}>
            <button type="button" className="dtl-dedit" aria-pressed={pinned === e} onClick={() => onPick(e)}>
              <span className="dtl-dedit-h">
                <span className="dtl-dedit-t">{timeOf(e.at)}</span>
                <Counts added={e.added} removed={e.removed} narrow={narrow} binary={isBinary(e)} />
              </span>
              {e.diff?.length ? <DiffLines lines={e.diff} /> : !isBinary(e) && <span className="dtl-dedit-none">No lines kept for this edit</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
