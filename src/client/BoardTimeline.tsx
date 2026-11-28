import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BoardCard } from "../board.js";
import { ENGINE_NAMES } from "../types.js";
import type { BoardLane, LaneBlock, LaneHandoff } from "../board-lanes.js";
import type { Need } from "../needs-rank.js";
import { NEEDS_CHANGED } from "./Attention.js";
import { api } from "./api.js";
import { Mark, firstChoice, runClock } from "./Board.js";
import { tickEvery, useNow } from "./presence.js";
import { Shine } from "./shine.js";
import { loadRecents, type Identity, type Project } from "./storage.js";
import { isTyping } from "./ui.js";
import { Badge, Button, SegmentedControl } from "@/components/affect";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/dass/page-bits";
import "./board-timeline.css";

/**
 * The Agent Board's Timeline (Arun, 2026-11-27, of the approved mock's section B: "build it boss i want to integrate all of
 * these"): a row per agent, grouped by project, with the last half hour sliding left as time passes. What the board's lanes
 * can't show: time. A run is a block that grows into "now"; a failed one is red; where an agent waits on a person is amber, with
 * a flag that answers it; a pull request is green; and work passed from one agent to another is a dashed line between their rows.
 *
 * The rows are the board's own cards, already named and filtered by it; the blocks are read from each session's log by the
 * server (board-lanes.ts) and asked for again every few seconds while the window shows. Everything is placed on one time base,
 * the shared clock's, so blocks, gridlines and hand-offs move together.
 */

export type TimelineRange = "30m" | "2h" | "today";
const RANGES: { value: TimelineRange; label: string }[] = [
  { value: "30m", label: "30m" },
  { value: "2h", label: "2h" },
  { value: "today", label: "Today" },
];
const RANGE_KEY = "friday.board.timeline.range";
const POLL_MS = 5000;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** The rows' heights, as the mock draws them: the hand-offs are placed by them. */
const ROW = 46;
const GROUP = 26;

type Lanes = { now: number; since: number; lanes: BoardLane[]; handoffs: LaneHandoff[] };

function readRange(): TimelineRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return v === "2h" || v === "today" ? v : "30m";
  } catch {
    return "30m";
  }
}

/** How far back the window goes from `now`: Today is since midnight here, and never less than an hour, so a look just after midnight isn't a sliver. */
function spanOf(range: TimelineRange, now: number): number {
  if (range === "30m") return 30 * MIN;
  if (range === "2h") return 2 * HOUR;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.max(HOUR, now - d.getTime());
}

const rangeWords = (range: TimelineRange) => (range === "30m" ? "the last 30 minutes" : range === "2h" ? "the last 2 hours" : "today");
const ago = (ms: number) => {
  const m = Math.round(ms / MIN);
  return m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
};
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The gridlines: how long ago for the short ranges, the hour of the day for Today; fewer of them on a narrow timeline. */
function ticksOf(range: TimelineRange, start: number, now: number, width: number): { at: number; label: string }[] {
  const span = now - start;
  let out: { at: number; label: string }[] = [];
  if (range === "today") {
    const step = Math.max(1, Math.ceil(span / HOUR / 8)) * HOUR;
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + HOUR; t < now; t += HOUR) {
      const h = new Date(t).getHours();
      if (t > start && (h * HOUR) % step === 0) out.push({ at: t, label: new Date(t).toLocaleTimeString([], { hour: "numeric" }) });
    }
  } else {
    const step = range === "30m" ? 5 * MIN : 20 * MIN;
    for (let back = span - step; back > 0; back -= step) out.push({ at: now - back, label: ago(back) });
  }
  // A label needs about 56px, and the "now" chip the last 44; one centred on its line also needs half its width from the left edge.
  const room = (t: { at: number }) => ((now - t.at) / span) * width;
  out = out.filter((t) => room(t) > 44 && width - room(t) > 24);
  while (out.length > 1 && width / (out.length + 1) < 56) out = out.filter((_, i) => i % 2 === (out.length - 1) % 2);
  return out;
}

const KIND_WORDS: Record<LaneBlock["kind"], string> = { run: "Ran", wait: "Waited", fail: "Failed", done: "Finished" };

/** One block's place on the track, in hundredths of its width, cut at the window's edges. */
function placeOf(b: LaneBlock, start: number, now: number): { left: number; right: number; cut: boolean } {
  const span = now - start;
  const x = (t: number) => Math.min(100, Math.max(0, ((t - start) / span) * 100));
  return { left: x(b.start), right: b.end === null ? 100 : x(b.end), cut: b.start < start };
}

function blockTitle(b: LaneBlock, now: number, from?: string): string {
  const when = b.end === null ? `since ${clock(b.start)}` : b.end - b.start < MIN ? `at ${clock(b.start)}` : `${clock(b.start)} to ${clock(b.end)}`;
  const state = b.kind === "run" && b.end === null ? "Running" : b.kind === "wait" && b.end === null ? "Waiting" : KIND_WORDS[b.kind];
  const long = b.end === null ? ` (${runClock(now - b.start)})` : b.end - b.start >= MIN ? ` (${ago(b.end - b.start)})` : "";
  return `${b.label}. ${state} ${when}${long}${from ? `. Handed over by ${from}` : ""}`;
}

/** Who a card is, as the board's cards say it: with everything here yours, names lose their "Arun's". */
const whoOf = (card: BoardCard, solo: boolean) => (solo ? card.agent.replace(/^[^']+'s /, "") : card.agent);
/** The tool names a card falls back to when its agent has no name of its own ("Arun's Claude Code", "Friday Code"). */
const TOOL_WORDS = [...Object.values(ENGINE_NAMES), "Friday Code"];
const toolNamed = (card: BoardCard) => TOOL_WORDS.some((w) => card.agent === w || card.agent.endsWith(`'s ${w}`));
const PLAIN_TITLE = /^(new thread|untitled session|crew)$/i;
/**
 * A row's name (Arun, 2026-11-28: "timeline is just showing random stuff like friday code"): an agent with a name of its own (a
 * Captain's crew) by that name; otherwise by what it works on, the thread's title or its task, with the tool beside it.
 */
const nameOf = (card: BoardCard, solo: boolean) => {
  if (!toolNamed(card)) return whoOf(card, solo);
  const title = card.title.trim();
  return (title && !PLAIN_TITLE.test(title) ? title : card.task.trim() || title) || whoOf(card, solo);
};
/** The line under a row's name: the tool, when the name is the work, and what it was asked or its state. */
const subOf = (card: BoardCard, solo: boolean, name: string) => {
  const tool = toolNamed(card) ? whoOf(card, solo) : "";
  const live = card.column === "working" || card.column === "needs";
  const what = card.task && card.task !== name ? card.task : live ? card.branch : `${card.status}${card.pr?.number ? ` #${card.pr.number}` : ""}`;
  return [tool || (live ? card.title : card.title !== name ? card.title : ""), what].filter(Boolean).join(" · ");
};

type Row = { card: BoardCard; blocks: LaneBlock[]; top: number };
type Group = { id: string; name: string; top: number; rows: Row[] };
type Sel = { row: string; block: string | null };

export default function BoardTimeline({
  identity,
  cards,
  sids,
  projectOf,
  projects,
  needs,
  onOpen,
  onAnswer,
  solo,
  query,
  rangeSlot,
}: {
  identity: Identity;
  /** The agents, as the board has named and filtered them: a row each. */
  cards: BoardCard[];
  sids: string[];
  projectOf: Map<string, string>;
  projects: Project[];
  /** What waits on this person and can be answered here. */
  needs: Need[];
  onOpen: (sid: string) => void;
  onAnswer: (need: Need, value: string) => void;
  solo: boolean;
  query: string;
  /** Where the range switch goes when the page has a place for it in its own top row (the mock's); without one it sits in the timeline's corner. */
  rangeSlot?: HTMLElement | null;
}) {
  const [range, setRangeState] = useState<TimelineRange>(readRange);
  const setRange = (r: TimelineRange) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // Not remembered where storage is off; the switch still works.
    }
  };

  // The blocks, asked for like the board's cards: every few seconds, not while the window is hidden, and at once when it is back
  // or something was answered. The server's clock comes with them, so a computer whose clock is off still draws "now" at now.
  const [got, setGot] = useState<Lanes | null>(null);
  const [failed, setFailed] = useState(false);
  const skew = useRef(0);
  const sidKey = sids.join(",");
  useEffect(() => {
    if (!sidKey) {
      setGot({ now: Date.now(), since: 0, lanes: [], handoffs: [] });
      return;
    }
    let live = true;
    const ask = async () => {
      if (document.hidden) return;
      try {
        const r = await api<Lanes>(identity, "/api/board/lanes", { method: "POST", body: JSON.stringify({ sids: sidKey.split(","), since: Date.now() + skew.current - spanOf(range, Date.now()) }) });
        if (!live) return;
        const off = r.now - Date.now();
        skew.current = Math.abs(off) > 2000 ? off : 0;
        setGot(r);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    };
    void ask();
    const t = setInterval(ask, POLL_MS);
    const wake = () => void ask();
    document.addEventListener("visibilitychange", wake);
    addEventListener("friday:attention", wake);
    addEventListener(NEEDS_CHANGED, wake);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      removeEventListener("friday:attention", wake);
      removeEventListener(NEEDS_CHANGED, wake);
    };
  }, [identity.id, sidKey, range]);

  // The window slides on the shared ticker (presence.tsx), still while the window is hidden: each second for half an hour, where
  // a second is about half a pixel, and slower for the longer ranges, where it is far less.
  const [tick, setTick] = useState(Date.now);
  useEffect(() => tickEvery(range === "30m" ? 1000 : range === "2h" ? 5000 : 30_000, setTick), [range]);
  const now = Math.max(tick, got ? got.now - skew.current : 0) + skew.current;
  const start = now - spanOf(range, now);

  // Rows: the board's cards by project, the ungrouped last; no heading when there is only one group.
  const laneOf = useMemo(() => new Map((got?.lanes ?? []).map((l) => [l.id, l])), [got]);
  const { groups, rows, height, quiet } = useMemo(() => {
    const named = new Map(projects.map((p) => [p.id, p.name]));
    const by = new Map<string, BoardCard[]>();
    // A row keeps its place while its agent's state changes: sessions in the order they were listed (`sids`), each one's agents
    // in the session's own order, the main one first. The board sorts its cards by what is pressing; a timeline that reshuffled
    // as often couldn't be read along.
    const sidAt = new Map(sids.map((sid, i) => [sid, i]));
    const laneAt = new Map((got?.lanes ?? []).map((l, i) => [l.id, i]));
    const place = (c: BoardCard) => laneAt.get(c.id) ?? (c.lane === "main" ? -1 : 1e9);
    // Only agents: a card for something else waiting on you (a pull request to review) has no session and no lane to draw.
    // Only agents with something in the window, or working or waiting now: a row for every idle thread was dozens of empty lines
    // (Arun, 2026-11-28: "not accurate at all"). The rest are counted under the chart.
    const inWindow = (c: BoardCard) => c.column === "working" || c.column === "needs" || (laneOf.get(c.id)?.blocks ?? []).some((b) => b.end === null || b.end >= start);
    const ordered = cards.filter((c) => c.sid && inWindow(c)).sort((x, y) => (sidAt.get(x.sid) ?? 1e9) - (sidAt.get(y.sid) ?? 1e9) || place(x) - place(y));
    for (const c of ordered) {
      const p = projectOf.get(c.sid) ?? "";
      const key = named.has(p) ? p : "";
      by.set(key, [...(by.get(key) ?? []), c]);
    }
    const order = [...projects.map((p) => p.id).filter((id) => by.has(id)), ...(by.has("") ? [""] : [])];
    const headed = order.length > 1;
    let top = 0;
    const groups: Group[] = order.map((id) => {
      const g: Group = { id, name: id ? named.get(id)! : "Other", top, rows: [] };
      if (headed) top += GROUP;
      for (const card of by.get(id)!) {
        g.rows.push({ card, blocks: (laneOf.get(card.id)?.blocks ?? []).filter((b) => b.end === null || b.end >= start), top });
        top += ROW;
      }
      return g;
    });
    const quiet = cards.filter((c) => c.sid).length - ordered.length;
    return { groups: headed ? groups : groups.map((g) => ({ ...g, name: "" })), rows: groups.flatMap((g) => g.rows), height: top, quiet };
    // `start` moves every tick; a block leaves when its end passes it, which the minute's turn is often enough to notice.
  }, [cards, sidKey, projects, projectOf, laneOf, Math.floor(start / 10_000)]);
  const rowOf = useMemo(() => new Map(rows.map((r) => [r.card.id, r])), [rows]);
  const anyBlock = rows.some((r) => r.blocks.length > 0);

  // What is selected: a block, or a row with none. Nothing picked yet (or what was picked has left the window): what most wants a
  // look, the first agent waiting on you, then the first one running, so the row under the timeline is never about nothing.
  const [picked, setPicked] = useState<Sel | null>(null);
  const sel = useMemo((): Sel | null => {
    if (picked) {
      const r = rowOf.get(picked.row);
      if (r && (!picked.block || r.blocks.some((b) => b.id === picked.block))) return picked;
      if (r) return { row: r.card.id, block: r.blocks.at(-1)?.id ?? null };
    }
    const open = (r: Row, kind: LaneBlock["kind"]) => r.blocks.findLast((b) => b.kind === kind && b.end === null);
    for (const r of rows) if (r.card.you && open(r, "wait")) return { row: r.card.id, block: open(r, "wait")!.id };
    for (const r of rows) if (open(r, "run")) return { row: r.card.id, block: open(r, "run")!.id };
    return null;
  }, [picked, rowOf, rows]);
  const selRow = sel ? rowOf.get(sel.row) : undefined;
  const selBlock = selRow && sel?.block ? selRow.blocks.find((b) => b.id === sel.block) : undefined;

  // The need a waiting agent's flag answers: the one its card waits on (BoardCard.waits are the Needs you page's ids).
  const needOf = (card: BoardCard) => (card.you ? needs.find((n) => card.waits?.includes(n.id)) : undefined);

  // The track's width, for what is drawn in pixels: the hand-offs' curves, which labels fit, how many gridlines.
  const layer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks = useMemo(() => ticksOf(range, start, now, width || 800), [range, Math.floor(start / 1000), width]);
  const xOf = (t: number) => Math.min(1, Math.max(0, (t - start) / (now - start)));

  // The list scrolls inside the page, under the axis: as tall as the window leaves it, so twelve agents don't push the row under
  // the timeline off the page. Measured, since the page above it is the board's.
  const root = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !root.current) return;
    const fit = () => {
      let page: HTMLElement | null = root.current!.parentElement;
      while (page && !/(auto|scroll)/.test(getComputedStyle(page).overflowY)) page = page.parentElement;
      const top = el.getBoundingClientRect().top + (page?.scrollTop ?? 0);
      root.current!.style.setProperty("--btl-top", `${Math.round(top)}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    if (root.current.parentElement) ro.observe(root.current.parentElement);
    addEventListener("resize", fit);
    return () => (ro.disconnect(), removeEventListener("resize", fit));
  }, []);

  // Hand-offs, on the rows' own geometry: down (or up) from the row that gave the work at that moment, round the corner, and
  // along to where the other agent took it up.
  const fromName = new Map<string, string>();
  const curves = width
    ? (got?.handoffs ?? []).flatMap((h, i) => {
        const a = rowOf.get(h.from);
        const b = rowOf.get(h.to);
        if (!a || !b || h.at < start) return [];
        const took = b.blocks.find((x) => x.kind !== "done" && x.start >= h.at - 2000 && x.start <= h.at + 10 * MIN);
        if (took) fromName.set(took.id, nameOf(a.card, solo));
        // The line comes down a little before the moment, so its corner has room to turn into the block that began then.
        const x1 = Math.max(1, Math.round(xOf(h.at) * width) - 12) + 0.5;
        const x2 = Math.max(x1 + 6, took ? Math.round(xOf(took.start) * width) : x1 + 14);
        const down = b.top > a.top;
        const y1 = a.top + (down ? 37 : 9);
        const y2 = b.top + ROW / 2 + 0.5;
        const r = Math.min(10, Math.abs(y2 - y1), x2 - x1);
        const d = `M${x1} ${y1} V${y2 - (down ? r : -r)} Q${x1} ${y2} ${x1 + r} ${y2} H${x2}`;
        return [{ key: `${h.from}>${h.to}@${h.at}#${i}`, d, live: took?.end === null }];
      })
    : [];

  // Keys, as the board's foot says them: J and K between agents, the arrows between an agent's blocks, Enter opens.
  const keys = useRef({ rows, sel, onOpen });
  keys.current = { rows, sel, onOpen };
  const focusSel = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const t = e.target instanceof Element ? e.target : null;
      const inside = !!t && !!root.current?.contains(t);
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const { rows, sel, onOpen } = keys.current;
      if (!rows.length) return;
      const at = sel ? rows.findIndex((r) => r.card.id === sel.row) : -1;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const go = (next: Sel) => {
        e.preventDefault();
        focusSel.current = true;
        setPicked(next);
      };
      if (key === "j" || key === "k") {
        const r = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (key === "j" ? 1 : -1)))]!;
        go({ row: r.card.id, block: r.blocks.at(-1)?.id ?? null });
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        // The range switch and any other group of options keep their own arrows.
        if (t?.closest('[role="radiogroup"], [role="tablist"], [role="listbox"]')) return;
        const r = rows[at < 0 ? 0 : at]!;
        if (!r.blocks.length) return;
        const i = r.blocks.findIndex((b) => b.id === sel?.block);
        const j = i < 0 ? r.blocks.length - 1 : Math.min(r.blocks.length - 1, Math.max(0, i + (key === "ArrowRight" ? 1 : -1)));
        go({ row: r.card.id, block: r.blocks[j]!.id });
      } else if (key === "Enter" && at >= 0) {
        // On a button that isn't a block of the timeline, Enter is that button's.
        if (t && t !== document.body && !(inside && t.closest(".btl-blk, .btl-who"))) return;
        e.preventDefault();
        onOpen(rows[at]!.card.sid);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // The keys move the focus with the selection, and bring it into view in the list.
  useEffect(() => {
    if (!focusSel.current || !sel) return;
    focusSel.current = false;
    const el = root.current?.querySelector<HTMLElement>(`[data-sel="${CSS.escape(sel.block ?? sel.row)}"]`);
    el?.focus({ preventScroll: true });
    el?.closest(".btl-row")?.scrollIntoView({ block: "nearest" });
  }, [sel?.row, sel?.block]);

  const rangeSwitch = <SegmentedControl<TimelineRange> aria-label="Time range" variant="tray" size="sm" value={range} onChange={setRange} options={RANGES} />;
  const emptyLine = !cards.length ? (query.trim() ? `No agents match "${query.trim()}"` : "No agents yet. Start a session and it shows here.") : got && !anyBlock ? `Nothing ran in ${rangeWords(range)}` : failed && !got ? "Couldn't load the timeline. Trying again." : "";

  return (
    <section ref={root} className="btl" aria-label="Timeline" data-range={range}>
      {rangeSlot && createPortal(rangeSwitch, rangeSlot)}
      <div className="btl-card">
        <div ref={scroller} className="btl-scroll">
          <div className="btl-axis">
            <div className="btl-corner">{!rangeSlot && rangeSwitch}</div>
            <div className="btl-ticks" aria-hidden>
              {ticks.map((t) => (
                <span key={t.label} style={{ left: `${xOf(t.at) * 100}%` }}>
                  {t.label}
                </span>
              ))}
              <span className="btl-now">now</span>
            </div>
          </div>
          <div className="btl-body" style={{ minHeight: rows.length ? height : undefined }}>
            <div ref={layer} className="btl-layer" aria-hidden>
              {ticks.map((t) => (
                <i key={t.label} style={{ left: `${xOf(t.at) * 100}%` }} />
              ))}
            </div>
            {groups.map((g) => (
              <div key={g.id || "none"} role="group" aria-label={g.name || "Agents"}>
                {g.name && (
                  <div className="btl-grp">
                    <span>{g.name}</span>
                  </div>
                )}
                {g.rows.map((r) => (
                  <TimelineRow
                    key={r.card.id}
                    row={r}
                    solo={solo}
                    start={start}
                    now={now}
                    width={width}
                    sel={sel?.row === r.card.id ? sel : null}
                    need={needOf(r.card)}
                    fromName={fromName}
                    onPick={(block) => setPicked({ row: r.card.id, block })}
                    onOpen={() => onOpen(r.card.sid)}
                    onAnswer={onAnswer}
                  />
                ))}
              </div>
            ))}
            {curves.length > 0 && (
              <svg className="btl-hands" width={width} height={height} aria-hidden>
                {curves.map((c) => (
                  <path key={c.key} d={c.d} className={c.live ? "is-live" : undefined} />
                ))}
              </svg>
            )}
            {emptyLine && (
              <p className={rows.length ? "btl-empty is-over" : "btl-empty"} role="status">
                <span>{emptyLine}</span>
              </p>
            )}
          </div>
        </div>
        {got && quiet > 0 && rows.length > 0 && (
          <p className="btl-quiet">
            {quiet} idle agent{quiet === 1 ? "" : "s"} with nothing in {rangeWords(range)} not shown
          </p>
        )}
      </div>
      {selRow && <Peek key={selRow.card.id} identity={identity} skew={skew.current} row={selRow} block={selBlock} solo={solo} need={needOf(selRow.card)} onOpen={() => onOpen(selRow.card.sid)} onAnswer={onAnswer} />}
    </section>
  );
}

/** One agent: who it is, and its blocks on the track. */
function TimelineRow({ row, solo, start, now, width, sel, need, fromName, onPick, onOpen, onAnswer }: { row: Row; solo: boolean; start: number; now: number; width: number; sel: Sel | null; need: Need | undefined; fromName: Map<string, string>; onPick: (block: string | null) => void; onOpen: () => void; onAnswer: (need: Need, value: string) => void }) {
  const { card, blocks } = row;
  const name = nameOf(card, solo);
  const needsYou = card.you && card.column === "needs";
  const idle = card.column === "idle";
  const sub = subOf(card, solo, name);
  const waiting = blocks.findLast((b) => b.kind === "wait" && b.end === null);
  const choice = need ? firstChoice(need) : null;
  const choiceLabel = choice ? (need!.choices.find((c) => c.value === choice)?.label ?? "Answer") : "";
  // With nothing selected in the row, its newest block is the one Tab reaches.
  const tabbed = sel?.block ?? blocks.at(-1)?.id;
  return (
    <div className={`btl-row${idle ? " is-dim" : ""}${sel ? " is-on" : ""}`} role="group" aria-label={`${name}: ${card.status}${card.title ? `, ${card.title}` : ""}`}>
      <button type="button" className="btl-who" data-sel={card.id} aria-pressed={!!sel && !sel.block} title={`${name} · ${sub}`} onClick={() => onPick(blocks.at(-1)?.id ?? null)} onDoubleClick={onOpen}>
        <Mark card={card} />
        <span className="btl-n">
          <b>
            <span className="btl-name">{name}</span>
            {needsYou ? <Badge tone="warning">Needs you</Badge> : idle ? <Badge>Idle</Badge> : null}
          </b>
          <span>{sub}</span>
        </span>
      </button>
      <div className="btl-track">
        {blocks.map((b) => {
          const p = placeOf(b, start, now);
          const live = b.end === null;
          const px = ((p.right - p.left) / 100) * width;
          // A moment (a pull request opened) is as wide as its words; near the right edge it grows leftwards instead.
          const point = b.kind === "done";
          // Never past the track's right edge, however short: one just begun is 14px back from now, a moment's run 6px.
          // A moment is never wider than the room on its side, so long words are cut rather than run off the track.
          const style = point ? (p.left > 82 ? { right: `${100 - p.left}%`, maxWidth: `${p.left}%` } : { left: `${p.left}%`, maxWidth: `${100 - p.left}%` }) : live ? { right: 0, width: `max(14px, ${100 - p.left}%)` } : { left: `min(${p.left}%, calc(100% - 6px))`, width: `${Math.max(0, p.right - p.left)}%` };
          const tiny = !point && width > 0 && px < 30;
          const title = blockTitle(b, now, fromName.get(b.id));
          const on = sel?.block === b.id;
          return (
            <Tip key={b.id} label={title} side="top">
              <button
                type="button"
                className={`btl-blk k-${b.kind}${live ? " is-live" : ""}${p.cut ? " is-cut" : ""}${tiny ? " is-tiny" : ""}${point ? " is-point" : ""}${on ? " is-sel" : ""}`}
                style={style}
                data-sel={b.id}
                aria-label={title}
                aria-pressed={on}
                tabIndex={b.id === tabbed ? 0 : -1}
                onClick={() => onPick(b.id)}
                onDoubleClick={onOpen}
              >
                {!tiny && (live && b.kind === "run" ? <Shine className="btl-lbl">{b.label}</Shine> : <span className="btl-lbl">{b.label}</span>)}
              </button>
            </Tip>
          );
        })}
        {waiting && card.you && (
          <Tip label={choice ? `Answer "${choiceLabel}" to ${name}` : `Open the session to answer ${name}`} side="top">
            <button type="button" className="btl-flag" onClick={() => (choice && need ? onAnswer(need, choice) : onOpen())}>
              <svg viewBox="0 0 12 12" aria-hidden>
                <path d="M6 2.2 10.6 10H1.4Z" fill="currentColor" />
              </svg>
              <span>{choice ? choiceLabel : waiting.ask === "approval" ? "Allow" : "Answer"}</span>
            </button>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** The row under the timeline: what is selected, how long it has gone, what it is doing, and what can be done about it from here. */
function Peek({ identity, skew, row, block, solo, need, onOpen, onAnswer }: { identity: Identity; /** The server's clock less this computer's, as the timeline read it: the blocks are on the server's time. */ skew: number; row: Row; block: LaneBlock | undefined; solo: boolean; need: Need | undefined; onOpen: () => void; onAnswer: (need: Need, value: string) => void }) {
  const { card } = row;
  const running = block?.kind === "run" && block.end === null;
  const waitingNow = block?.kind === "wait" && block.end === null;
  const now = useNow(running || waitingNow ? 1000 : 30_000) + skew;
  // Spoken to as who does it ("Claude Code: writing its answer"), the work being its label above.
  const name = whoOf(card, solo);
  const label = block?.label ?? (card.task || card.title);
  const time = !block ? "" : running ? runClock(now - block.start) : waitingNow ? `Waiting ${runClock(now - block.start)}` : block.end! - block.start >= MIN ? `${ago(block.end! - block.start)} · ${clock(block.start)}` : clock(block.start);
  // What it is doing: a running agent's live line as its card has it; otherwise what the block left behind.
  const doing = running ? card.detail || block.detail || "Working" : block ? block.detail || (block.kind === "run" ? "Finished" : KIND_WORDS[block.kind]) : card.detail || card.status;
  const facts = [block?.files ? `${block.files} file${block.files === 1 ? "" : "s"}` : "", block?.tools ? `${block.tools} tool${block.tools === 1 ? "" : "s"}` : ""].filter(Boolean);
  const choice = waitingNow && need ? firstChoice(need) : null;

  // Steer: a message to this agent, through the session's own way in (the route its composer's messages take), so the session's
  // rules decide whether it may. Only for a session this app holds the way into.
  const invite = useMemo(() => loadRecents().find((r) => r.sid === card.sid)?.invite ?? "", [card.sid]);
  const [steering, setSteering] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (!said || said.bad) return;
    const t = setTimeout(() => setSaid(null), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const send = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(card.sid)}/instruct?invite=${encodeURIComponent(invite)}`, { method: "POST", body: JSON.stringify({ text: words, ...(card.lane !== "main" ? { lane: card.lane } : {}) }) });
      setSaid({ text: `Sent to ${name}` });
      setText("");
      setSteering(false);
    } catch (e) {
      setSaid({ text: (e as Error).message || "Couldn't send that.", bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="btl-peek" role="region" aria-label={`Selected: ${nameOf(card, solo)}`}>
      <Mark card={card} />
      <div className="btl-peek-n">
        <b>
          <span className="btl-peek-label" title={label}>
            {label}
          </span>
          {time && (
            <span className={`btl-clock${running ? " is-run" : waitingNow ? " is-wait" : ""}`}>
              {running && <i className="btl-spin" aria-hidden />}
              {time}
            </span>
          )}
        </b>
        <span className={said?.bad ? "btl-peek-said is-bad" : "btl-peek-said"} role="status" title={said ? undefined : [doing, ...facts].join(" · ")}>
          {said ? said.text : [`${name}: ${doing}`, ...facts].join(" · ")}
        </span>
      </div>
      {steering ? (
        <form
          className="btl-steer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            autoFocus
            value={text}
            placeholder={`Tell ${name} what to do next`}
            aria-label={`Steer ${name}`}
            className="h-7 rounded-[6px] text-[13px] md:text-[13px]"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              setSteering(false);
            }}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!text.trim()}>
            Send
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setSteering(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="btl-acts">
          {choice && need && (
            <Button size="sm" variant="secondary" onClick={() => onAnswer(need, choice)}>
              {need.choices.find((c) => c.value === choice)?.label ?? "Answer"}
            </Button>
          )}
          {running && invite && (
            <Button size="sm" variant="secondary" onClick={() => (setSaid(null), setSteering(true))}>
              Steer
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={onOpen} iconRight={<kbd aria-hidden>↵</kbd>}>
            Open
          </Button>
        </div>
      )}
    </div>
  );
}
