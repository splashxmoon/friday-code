// Agent Recap (affectUI Pro, rebuilt by hand from its public preview; SPEC agent-recap): what the agents did while you were away.
// The night is a small chart with a smooth peak per event and a dot on each, then three wells side by side: what needs you, what
// failed and what's done, each card acted on right where it sits. On open the night replays: the line draws left to right, each
// dot pops as it's passed, its card fades in and the counts count along. Acting swaps the card's footer and nothing else moves.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Tile, VizSpinner, useReducedMotion } from "./viz-parts.js";
import "./agent-viz.css";
import "./agent-recap.css";

export type RecapKind = "needs" | "failed" | "done";
type When = number | string | Date;

export interface RecapEvent {
  id: string;
  kind: RecapKind;
  /** When it happened. */
  at: When;
  title: string;
  /** The line under the title: who did it and why ("Support agent · over the $200 limit"). A failed one's reason shows in red. */
  detail?: string;
  /** The service or tool it came from, drawn in an 18px tile. */
  logo?: ReactNode;
  /** How many things it covered ("38" tickets); also makes its peak on the chart taller. */
  count?: number;
  /** The main button's label: "Approve", "Merge" (needs), "Retry" (failed). */
  action?: string;
  /** The tag once it's acted on: "Approved", "Merged". Default "Done" (needs, done) or "Fixed" (failed). */
  doneLabel?: string;
  /** false: once acted on it can't be taken back here, so its card keeps its tag and no Undo. */
  undo?: false;
}

export type RecapActionKind = "primary" | "review";

export interface AgentRecapProps {
  events: RecapEvent[];
  /** Where the night starts; the earliest event when left out. */
  since?: When;
  /** Where it ends; the time it renders when left out. */
  until?: When;
  /** The card's main button or Review. A promise keeps the card working until it settles; a rejection leaves it as it was. */
  onAction?: (event: RecapEvent, kind: RecapActionKind) => unknown;
  onUndo?: (event: RecapEvent) => unknown;
  onRedo?: (event: RecapEvent) => unknown;
  /** Cards per lane (3). Each lane keeps room for that many, so all three are the same height. */
  limit?: number;
  /** How long the night replays on open, in ms (1800); 0 shows it all at once. */
  replay?: number;
  title?: string;
  locale?: string;
  className?: string;
}

const LANES: { kind: RecapKind; name: string; empty: string }[] = [
  { kind: "needs", name: "Needs you", empty: "Nothing needs you" },
  { kind: "failed", name: "Failed", empty: "Nothing failed" },
  { kind: "done", name: "Done", empty: "Nothing done yet" },
];

// The chart's measures: 96 tall, the flat line 5 above the bottom, the tallest peak 12 below the top; a peak is a bell 17px wide
// either side of its centre. An event without a count stands at .73 of the tallest.
const H = 96;
const BASE = 91;
const TOP = 12;
const SIGMA = 17;
const LOW = 0.73;

const ms = (w: When) => (w instanceof Date ? w.getTime() : typeof w === "number" ? w : new Date(w).getTime());

const ICONS: Record<RecapKind, ReactNode> = {
  done: (
    <svg className="fi" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" />
      <path d="M4.7 7.2l1.6 1.5 3-3.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  needs: (
    <svg className="fi" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="7" cy="4.8" r="2.4" />
      <path d="M2.6 12.2c.5-2.3 2.3-3.6 4.4-3.6s3.9 1.3 4.4 3.6" strokeLinecap="round" />
    </svg>
  ),
  failed: (
    <svg className="fi" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M7 1.9l5.4 9.4H1.6z" strokeLinejoin="round" />
      <path d="M7 5.6v2.3M7 9.6v.05" strokeLinecap="round" />
    </svg>
  ),
};

/** "13h 30m", "45m", "2d 4h": how long you were away. */
function spanOf(msLong: number): string {
  const m = Math.max(0, Math.round(msLong / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  return h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

/** Each event's state as it stands now: acted on (approved, fixed, done) or not, and what it's busy with. */
type Busy = "primary" | "review" | "undo" | "redo";

export function AgentRecap({ events, since, until, onAction, onUndo, onRedo, limit = 3, replay = 1800, title = "While you were away", locale, className = "" }: AgentRecapProps) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [rendered] = useState(() => Date.now());
  const end = until != null ? ms(until) : rendered;
  const sorted = useMemo(() => [...events].sort((a, b) => ms(a.at) - ms(b.at)), [events]);
  const start = since != null ? ms(since) : sorted.length ? ms(sorted[0]!.at) : end - 3_600_000;
  const span = Math.max(1, end - start);

  const time = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }), [locale]);
  const full = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }), [locale]);
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);

  // Acted on: the done ones start that way; Approve or Retry turns the others, Undo turns any back.
  const [acted, setActed] = useState<Record<string, boolean>>(() => Object.fromEntries(events.map((e) => [e.id, e.kind === "done"])));
  const isActed = (e: RecapEvent) => acted[e.id] ?? e.kind === "done";
  const [busy, setBusy] = useState<Record<string, Busy | undefined>>({});
  const [said, setSaid] = useState("");
  const [lit, setLit] = useState<string | null>(null);
  const [open, setOpen] = useState<Partial<Record<string, boolean>>>({});
  const [guide, setGuide] = useState<number | null>(null);

  // The chart draws in real pixels, so its bells keep their shape at any width.
  const chartRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(772);
  useLayoutEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 772));
    ro.observe(el);
    setW(el.clientWidth || 772);
    return () => ro.disconnect();
  }, []);

  // The replay: 0 → 1 across `replay` ms on open; everything up to it is shown.
  const still = reduced || replay <= 0;
  const [p, setP] = useState(still ? 1 : 0);
  useEffect(() => {
    if (still) return setP(1);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / replay);
      setP(k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [still, replay]);

  const chart = useMemo(() => {
    const maxCount = Math.max(0, ...sorted.map((e) => e.count ?? 0));
    const pts = sorted
      .map((e) => ({ e, x: ((ms(e.at) - start) / span) * w, amp: maxCount && e.count ? LOW + (1 - LOW) * Math.pow(e.count / maxCount, 0.9) : LOW }))
      .filter((d) => d.x >= -SIGMA * 3 && d.x <= w + SIGMA * 3);
    const v = (x: number) => pts.reduce((s, d) => s + d.amp * Math.exp(-((x - d.x) ** 2) / (2 * SIGMA * SIGMA)), 0);
    const xs: number[] = [];
    for (let x = 0; x < w; x += 2) xs.push(x);
    xs.push(w);
    const vals = xs.map(v);
    const scale = (BASE - TOP) / Math.max(1, ...vals);
    const y = (val: number) => BASE - val * scale;
    const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y(vals[i]!).toFixed(2)}`).join("");
    const dots = pts.filter((d) => d.x >= 0 && d.x <= w).map((d) => ({ e: d.e, x: d.x, y: y(v(d.x)) }));
    // The grid: a line on every whole hour, and four rows.
    const hours: number[] = [];
    const hour = 3_600_000;
    const stepH = span > 36 * hour ? 6 : span > 18 * hour ? 2 : 1;
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + hour; t < end; t += hour) if (new Date(t).getHours() % stepH === 0) hours.push(((t - start) / span) * w);
    return { line, area: `${line}L${w} ${H}L0 ${H}Z`, dots, hours };
  }, [sorted, start, span, end, w]);

  const shown = p * w + 0.5;
  const passed = useCallback((id: string) => p >= 1 || (chart.dots.find((d) => d.e.id === id)?.x ?? -1) <= shown, [p, chart.dots, shown]);

  // The summary as it stands: acted-on ones count as done; the rest where they started. It counts along with the replay.
  const counts = { done: 0, needs: 0, failed: 0 };
  for (const e of sorted) {
    if (!passed(e.id)) continue;
    if (isActed(e)) counts.done++;
    else if (e.kind !== "done") counts[e.kind]++;
  }

  // Focus follows an action: to Undo once it's done, back to the main button once it's undone.
  const cards = useRef(new Map<string, HTMLLIElement>());
  const refocus = useRef<{ id: string; to: "undo" | "main" } | null>(null);
  useEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    cards.current.get(r.id)?.querySelector<HTMLButtonElement>(`[data-focus="${r.to}"]`)?.focus();
  });

  const run = (e: RecapEvent, what: Busy) => {
    if (busy[e.id]) return;
    const fn = what === "undo" ? () => onUndo?.(e) : what === "redo" ? () => onRedo?.(e) : () => onAction?.(e, what);
    const hadFocus = !!cards.current.get(e.id)?.contains(document.activeElement);
    const finish = () => {
      setBusy((b) => ({ ...b, [e.id]: undefined }));
      if (what === "review") return;
      const nowActed = what === "primary" || what === "redo";
      setActed((a) => ({ ...a, [e.id]: nowActed }));
      if (hadFocus) refocus.current = { id: e.id, to: nowActed ? "undo" : "main" };
      setSaid(`${nowActed ? tagOf(e) : "Undone"}: ${e.title}`);
    };
    let out: unknown;
    try {
      out = fn();
    } catch {
      setSaid(`That didn't go through: ${e.title}`);
      return;
    }
    if (out && typeof (out as Promise<unknown>).then === "function") {
      setBusy((b) => ({ ...b, [e.id]: what }));
      (out as Promise<unknown>).then(finish, () => {
        setBusy((b) => ({ ...b, [e.id]: undefined }));
        setSaid(`That didn't go through: ${e.title}`);
      });
    } else finish();
  };

  const litDot = chart.dots.find((d) => d.e.id === lit);

  // Pointing at the chart: a guide through its height that snaps to an event close by, which lights its card.
  const onChartMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - r.left;
    let best: { id: string; dx: number } | null = null;
    for (const d of chart.dots) {
      const dx = Math.abs(d.x - x);
      if (passed(d.e.id) && dx < 18 && (!best || dx < best.dx)) best = { id: d.e.id, dx };
    }
    setLit(best?.id ?? null);
    setGuide(best ? chart.dots.find((d) => d.e.id === best.id)!.x : x);
  };

  const sinceText = end - start > 24 * 3_600_000 ? `${day.format(start)} ${time.format(start)}` : time.format(start);

  return (
    <section className={`viz arc ${className}`} aria-label={title} data-replaying={p < 1 || undefined}>
      <header className="arc-head">
        <div>
          <h2 className="arc-title">{title}</h2>
          <p className="arc-since">
            Since {sinceText}
            <span className="arc-dur" title={`${full.format(start)} to ${full.format(end)}`}>
              {spanOf(span)}
            </span>
          </p>
        </div>
        <ul className="arc-sum" aria-label="Summary">
          <li>
            {ICONS.done}
            <b>{counts.done}</b> done
          </li>
          <li>
            {ICONS.needs}
            <b>{counts.needs}</b> need you
          </li>
          <li>
            {ICONS.failed}
            <b>{counts.failed}</b> failed
          </li>
        </ul>
      </header>

      <div className="arc-chart" ref={chartRef} aria-hidden="true" onPointerMove={onChartMove} onPointerLeave={() => (setLit(null), setGuide(null))}>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
          <defs>
            <linearGradient id={`${uid}-fade`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="arc-fade-top" />
              <stop offset="1" className="arc-fade-bottom" />
            </linearGradient>
            <clipPath id={`${uid}-clip`}>
              <rect x="0" y="0" width={Math.max(0, shown)} height={H} />
            </clipPath>
          </defs>
          <g className="arc-grid">
            {chart.hours.map((x) => (
              <line key={x} x1={x} x2={x} y1="0" y2={H} />
            ))}
            {[24, 48, 72].map((y) => (
              <line key={y} x1="0" x2={w} y1={y} y2={y} />
            ))}
          </g>
          <g clipPath={`url(#${uid}-clip)`}>
            <path className="arc-area" d={chart.area} fill={`url(#${uid}-fade)`} />
            <path className="arc-line" d={chart.line} />
          </g>
        </svg>
        <span className="arc-rule" />
        {guide != null && <span className="arc-guide" style={{ left: guide }} />}
        {chart.dots.map((d) => (
          <span
            key={d.e.id}
            className="arc-dot"
            data-k={isActed(d.e) ? "done" : d.e.kind}
            data-on={passed(d.e.id) || undefined}
            data-lit={lit === d.e.id || undefined}
            style={{ left: d.x, top: d.y }}
          />
        ))}
        {litDot && (
          <span className="arc-tip" data-edge={litDot.x < 110 ? "start" : litDot.x > w - 110 ? "end" : undefined} style={{ left: litDot.x, top: Math.max(-22, litDot.y - 30) }}>
            {time.format(ms(litDot.e.at))} · {litDot.e.title}
          </span>
        )}
      </div>
      <div className="arc-ends" aria-hidden="true">
        <span>{time.format(start)}</span>
        <span>{time.format(end)}</span>
      </div>

      <div className="arc-board" style={{ "--rc-n": limit } as CSSProperties}>
        {LANES.map((lane) => {
          const all = sorted.filter((e) => e.kind === lane.kind);
          // Past the first few, a lane opens in place to show every card (no inner scroll), and folds back.
          // Done cards carry no buttons, so one more fits in the height the others keep (Arun, 2026-11-28: "be able to handle 4 here").
          const cap = lane.kind === "done" ? limit + 1 : limit;
          const list = open[lane.kind] ? all : all.slice(0, cap);
          const more = all.length - cap;
          return (
            <div key={lane.kind} className="arc-lane" data-k={lane.kind}>
              <h3 className="arc-lane-head">
                <span className="arc-lane-name">
                  <span className="arc-lane-ic">{ICONS[lane.kind]}</span>
                  {lane.name}
                </span>
                <span className="arc-lane-n">
                  <span className="sr-only">, </span>
                  {all.length}
                </span>
              </h3>
              {list.length ? (
                <ul className="arc-list" aria-label={lane.name}>
                  {list.map((e) => (
                    <Card
                      key={e.id}
                      e={e}
                      acted={isActed(e)}
                      busy={busy[e.id]}
                      shown={passed(e.id)}
                      lit={lit === e.id}
                      time={time.format(ms(e.at))}
                      full={full.format(ms(e.at))}
                      iso={new Date(ms(e.at)).toISOString()}
                      onLit={(on) => setLit((l) => (on ? e.id : l === e.id ? null : l))}
                      onRun={(what) => run(e, what)}
                      cardRef={(el) => (el ? cards.current.set(e.id, el) : cards.current.delete(e.id))}
                    />
                  ))}
                </ul>
              ) : (
                <p className="arc-empty">{lane.empty}</p>
              )}
              {more > 0 && (
                <button type="button" className="arc-more" aria-expanded={!!open[lane.kind]} onClick={() => setOpen((o) => ({ ...o, [lane.kind]: !o[lane.kind] }))}>
                  <span>{open[lane.kind] ? "Show less" : `Show ${more} more`}</span>
                  <svg className="fi" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 4.5 6 7.5 9 4.5" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </section>
  );
}

const tagOf = (e: RecapEvent) => e.doneLabel ?? (e.kind === "failed" ? "Fixed" : "Done");

function Card({
  e,
  acted,
  busy,
  shown,
  lit,
  time,
  full,
  iso,
  onLit,
  onRun,
  cardRef,
}: {
  e: RecapEvent;
  acted: boolean;
  busy?: Busy;
  shown: boolean;
  lit: boolean;
  time: string;
  full: string;
  iso: string;
  onLit: (on: boolean) => void;
  onRun: (what: Busy) => void;
  cardRef: (el: HTMLLIElement | null) => void;
}) {
  const primary = e.action ?? (e.kind === "failed" ? "Retry" : e.kind === "needs" ? "Approve" : "Redo");
  const btn = (what: Busy, label: string, raised: boolean, focus?: "undo" | "main") => (
    <button
      type="button"
      className={raised ? "arc-btn raised" : "arc-btn"}
      aria-label={`${label}: ${e.title}`}
      data-focus={focus}
      data-busy={busy === what || undefined}
      disabled={!!busy && busy !== what}
      aria-disabled={busy === what || undefined}
      onClick={() => onRun(what)}
    >
      <span className="arc-btn-l">{label}</span>
      {busy === what && <VizSpinner size={11} />}
    </button>
  );
  return (
    <li
      ref={cardRef}
      className="arc-card"
      data-k={e.kind}
      data-in={shown || undefined}
      data-lit={lit || undefined}
      aria-busy={busy ? true : undefined}
      onPointerEnter={() => onLit(true)}
      onPointerLeave={() => onLit(false)}
      onFocus={() => onLit(true)}
      onBlur={(ev) => !ev.currentTarget.contains(ev.relatedTarget as Node) && onLit(false)}
    >
      <span className="arc-top">
        <Tile size={18}>{e.logo ?? ICONS[e.kind]}</Tile>
        <span className="arc-name">{e.title}</span>
      </span>
      <span className="arc-meta">
        {e.detail && <span className="arc-detail">{e.detail}</span>}
        <span className="arc-end">
          {e.count != null && <span className="arc-count">{e.count.toLocaleString()}</span>}
          <time dateTime={iso} title={full}>
            {time}
          </time>
        </span>
      </span>
      {/* Settled with nothing to undo (a Captain's done work), no foot: a lone "Done" tag under a card in the Done column said it twice. */}
      {acted && e.undo === false ? null : (
      <span className="arc-foot">
        <span className="arc-state">{acted ? <span className="arc-tag">{tagOf(e)}</span> : e.kind === "done" ? <span className="arc-tag off">Undone</span> : null}</span>
        {acted ? (
          e.undo === false ? null : btn("undo", "Undo", false, "undo")
        ) : (
          <>
            {e.kind === "needs" && btn("review", "Review", false)}
            {btn(e.kind === "done" ? "redo" : "primary", primary, e.kind !== "done", "main")}
          </>
        )}
      </span>
      )}
    </li>
  );
}
