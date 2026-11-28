/**
 * Where tokens went, as affectUI's Cost Waterfall rebuilt by hand in Friday's tokens (Arun, 2026-11-27, approving the mock: "looks
 * good"): each part a bar starting where the one above it ended, so the widths add up to the total, the heaviest tagged TOP, and a
 * switch to what it would come to at API price. Three ways in: a reply's token count (one turn, by kind of token), the thread
 * card's Agents header (the thread, by agent and turn) and a crew run's card (the run, by crew mate). Loaded when one is opened:
 * the session screen's budget has no room for it (test/client-bundle.test.ts). Data shaping is cost-fall.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { inOf, groupsOf, kindsOf, KIND_WORDS, modelWords, niceCeil, replyTurn, turnsOf, turnUsd, type Engines, type FallGroup, type FallKind, type FallTurn } from "../cost-fall.js";
import { priceFor, tokensTotal, type Tokens } from "../spend-price.js";
import type { SubTask } from "../sub-tasks.js";
import { shortTokens } from "../tool-usage.js";
import { ENGINE_NAMES, type EngineTool, type SessionEvent } from "../types.js";
import { runOf, type SessionState } from "../session/projection.js";
import type { RoomRun } from "../team-workflow-model.js";
import { EngineMark } from "./BrandMarks.js";
import "./cost-waterfall.css";

/*
 * What this chunk imports statically is split out of the chunks the session screen already loads (esbuild groups modules by the
 * entry points that reach them), so it reaches for little: who an agent is and how to go to a turn come from whoever opens it,
 * and the shine and the clock are drawn here rather than imported (shine.tsx, presence.tsx).
 */

type Mode = "tokens" | "usd";

/** Text that shines while its turn runs: shine.tsx's markup, which the app's stylesheet draws. */
function Shine({ children }: { children: ReactNode }) {
  return (
    <span className="shine">
      {children}
      <span className="shine-win" aria-hidden="true">
        <span className="shine-copy">{children}</span>
      </span>
    </span>
  );
}

/** Now, every second while something runs (its time climbs), else every half minute. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const usd = (n: number) => (n <= 0 ? "$0" : n < 0.001 ? "<$0.001" : n < 1 ? `$${n.toFixed(3).replace(/0$/, "")}` : `$${n.toFixed(2)}`);
const full = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${Math.round(n * 100)}%`;
/** "4m 12s", "42s", "1h 05m". */
function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
/** "Review the checkout PR" as said after a comma: its first letter only, so "PR" stays. */
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const toolWords = (tool?: string) => (tool && ENGINE_NAMES[tool as EngineTool]) || "Its tool";
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
/** What each kind is, in a few words, under the Heaviest stat. */
const GLOSS: Record<FallKind, string> = { cacheRead: "re-reading what it read before", input: "read fresh", cacheWrite: "kept for its next turn", output: "what it wrote", reasoning: "thinking it through" };

/* The marks, drawn to the mock's 12px grid. */
const KIND_ICON: Record<FallKind, ReactNode> = {
  cacheRead: <svg className="fi" viewBox="0 0 12 12"><ellipse cx="6" cy="3" rx="4" ry="1.6" fill="none" stroke="currentColor" /><path d="M2 3v6c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6V3M2 6c0 .9 1.8 1.6 4 1.6S10 6.9 10 6" fill="none" stroke="currentColor" /></svg>,
  input: <svg className="fi" viewBox="0 0 12 12"><path d="M2 6h6M5.5 3.5L8 6 5.5 8.5M10 2v8" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>,
  cacheWrite: <svg className="fi" viewBox="0 0 12 12"><ellipse cx="6" cy="3" rx="4" ry="1.6" fill="none" stroke="currentColor" /><path d="M2 3v6c0 .9 1.8 1.6 4 1.6M10 3v3M8.5 9.5h3M10 8v3" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>,
  output: <svg className="fi" viewBox="0 0 12 12"><path d="M4 6h6M7.5 3.5L10 6 7.5 8.5M2 2v8" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>,
  reasoning: <svg className="fi" viewBox="0 0 12 12"><path d="M6 1.5a3 3 0 012 5.2V8H4V6.7a3 3 0 012-5.2zM4.5 10h3" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>,
};
const ASK_ICON = <svg className="fi" viewBox="0 0 12 12"><path d="M2 2.5h8v5.5H5l-2.5 2V8H2z" fill="none" stroke="currentColor" strokeLinejoin="round" /></svg>;
const SUB_ICON = <svg className="fi" viewBox="0 0 12 12"><path d="M3.5 2v8M8.5 4v.5a2 2 0 01-2 2h-3" fill="none" stroke="currentColor" /><circle cx="3.5" cy="2" r="1" fill="currentColor" /><circle cx="3.5" cy="10" r="1" fill="currentColor" /><circle cx="8.5" cy="3.5" r="1" fill="currentColor" /></svg>;
const CHEV = <svg className="fi" viewBox="0 0 10 10"><path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>;
/** Grey in two weights: what was read or cached lighter, what was written heavier. */
const WEIGHT: Record<FallKind, string> = { cacheRead: "cwf-soft", cacheWrite: "cwf-soft", input: "", output: "cwf-out", reasoning: "cwf-out" };

/**
 * Esc closes it and gives the focus back to what opened it; opening moves the focus in, so Esc and the arrows work at once. The
 * card is focused, not a row: a screen reader hears its name first.
 */
function useCloser(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  useLayoutEffect(() => {
    back.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const close = () => {
    onClose();
    if (back.current instanceof HTMLElement) back.current.focus({ preventScroll: true });
  };
  return { ref, close };
}

function Switch({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <span className="cwf-sw" role="group" aria-label="Count in">
      <button type="button" aria-pressed={mode === "tokens"} onClick={() => onMode("tokens")}>Tokens</button>
      <button type="button" aria-pressed={mode === "usd"} onClick={() => onMode("usd")}>API price</button>
    </span>
  );
}

function Stat({ k, v, s, live = false }: { k: string; v: ReactNode; s: ReactNode; live?: boolean }) {
  return (
    <div className="cwf-stat">
      <span className="cwf-k">{k}</span>
      <span className="cwf-v">{live ? <Shine>{v}</Shine> : v}</span>
      <span className="cwf-s">{s}</span>
    </div>
  );
}

const Live = () => (
  <span className="cwf-live">
    <i aria-hidden="true" />
    Live
  </span>
);

const Axis = ({ end }: { end: string }) => (
  <span className="cwf-axis" aria-hidden="true">
    <span>0</span>
    <span>{end}</span>
  </span>
);

const bar = (left: number, width: number, cls: string) => <i className={`cwf-bar ${cls}`} style={{ left: `${Math.min(100, left * 100)}%`, width: `${Math.max(0, Math.min(1 - left, width) * 100)}%` }} />;

/* ── One turn, by kind of token: from a reply's count ─────────────────────────────────────────────────────────────────────── */

export function TurnFall({ events, engines, lane, from, to, ask, onClose }: { events: readonly SessionEvent[]; engines: Engines; lane: string; from: number; to: number; ask?: string; onClose: () => void }) {
  const turn = useMemo(() => replyTurn(events, engines, lane, from, to, ask), [events, engines, lane, from, to, ask]);
  const { ref, close } = useCloser(onClose);
  return (
    <div className="cwf-under">
      <TurnCard turn={turn} innerRef={ref} onKey={(e) => e.key === "Escape" && (e.stopPropagation(), close())} />
    </div>
  );
}

function TurnCard({ turn, innerRef, onKey }: { turn: FallTurn; innerRef?: React.Ref<HTMLDivElement>; onKey?: (e: KeyboardEvent) => void }) {
  const t = turn.tokens;
  const price = priceFor(turn.tool, turn.model);
  // The chart counts in price when there is one (cost first), else tokens; the switch changes only the chart.
  const [mode, setMode] = useState<Mode>(() => (price ? "usd" : "tokens"));
  const priced = mode === "usd" && !!price;
  const kinds = t ? kindsOf(t, price, priced) : [];
  const total = t ? tokensTotal(t) : 0;
  const cost = t && price ? kinds.reduce((n, k) => n + (k.usd ?? 0), 0) : 0;
  const end = priced ? niceCeil(cost) : niceCeil(total);
  const model = modelWords(turn.model);
  const ms = (turn.end ?? Date.now()) - turn.start;
  const top = kinds[0];
  // The stats don't follow the switch: the cost of every kind at list price, and the kind that cost the most (else the most tokens).
  const kindsPriced = t && price ? kindsOf(t, price, true) : kinds;
  const costAll = kindsPriced.reduce((n, k) => n + (k.usd ?? 0), 0);
  const dear = price ? [...kindsPriced].sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0))[0] : top;
  let at = 0;
  return (
    <div ref={innerRef} className="cwf" tabIndex={-1} role="region" aria-label="Where this turn's tokens went" onKeyDown={onKey}>
      <div className="cwf-head">
        <b>Where it went</b>
        {turn.ask && <span className="cwf-task">{turn.ask}</span>}
        <span className="cwf-grow" />
        <Switch mode={mode} onMode={setMode} />
        {turn.state === "running" && <Live />}
      </div>
      {!t ? (
        <div className="cwf-empty">
          <b>{toolWords(turn.tool)} didn't report tokens for this turn</b>
          <span>Its time is known: {took(ms)}. Turns from tools that report usage show here.</span>
        </div>
      ) : (
        <>
          {/* Cost first, then tokens, then what cost the most, whichever way the chart counts (Arun, 2026-11-27: "it should display
              cost first, tokens and most costly ... the switch is to change from tokens to price on the chart"). */}
          <div className="cwf-stats">
            <Stat k="Cost" v={price ? usd(costAll) : "Unpriced"} s={price ? "at API price · on your plan it's included" : `no list price for ${model || "its model"}`} />
            <Stat k="Tokens" v={shortTokens(total)} s={turn.context && turn.window ? `${shortTokens(inOf(t))} in · ${shortTokens(t.output)} out · ${pct(turn.context / turn.window)} of context` : t.cacheRead ? `${shortTokens(total - t.cacheRead)} without cache reads` : `${shortTokens(inOf(t))} in · ${shortTokens(t.output)} out`} />
            {dear && <Stat k="Most costly" v={KIND_WORDS[dear.kind]} s={price ? `${usd(dear.usd ?? 0)} · ${shortTokens(dear.tokens)} tokens` : `${shortTokens(dear.tokens)} tokens, ${GLOSS[dear.kind]}`} />}
          </div>
          <div className="cwf-cols k5" aria-hidden="true">
            <span>Kind</span>
            <Axis end={priced ? usd(end) : shortTokens(end)} />
            <span>Tokens</span>
            <span>Share</span>
            <span>API price</span>
          </div>
          <div className="cwf-rows" role="list">
            {kinds.map((k, i) => {
              const v = priced ? (k.usd ?? 0) : k.tokens;
              const left = at / end;
              at += v;
              return (
                <div key={k.kind} className="cwf-row k5" role="listitem" aria-label={`${KIND_WORDS[k.kind]}: ${full(k.tokens)} tokens${k.usd !== null ? `, ${usd(k.usd)} at API price` : ""}`}>
                  <span className="cwf-nm">
                    <span className="cwf-ind" />
                    <span className="cwf-ic">{KIND_ICON[k.kind]}</span>
                    <span className="cwf-t">{KIND_WORDS[k.kind]}</span>
                    {i === 0 && kinds.length > 1 && <span className="cwf-top">TOP</span>}
                  </span>
                  <span className="cwf-track">{bar(left, v / end, WEIGHT[k.kind])}</span>
                  <span className="cwf-n ink">{full(k.tokens)}</span>
                  <span className="cwf-n">{pct(priced ? v / (cost || 1) : k.tokens / (total || 1))}</span>
                  <span className={k.usd === null ? "cwf-n dash" : "cwf-n"}>{k.usd === null ? "–" : usd(k.usd)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="cwf-foot">
        <span>{priced ? `${model} list price, as published` : mode === "usd" ? `${model || "This model"} has no published list price here` : `${model ? `${model} · one turn` : "One turn"}, ${took(ms)}`}</span>
        <span className="cwf-grow" />
        {onKey && (
          <>
            <kbd>Esc</kbd>
            <span>close</span>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Turns grouped: a thread by agent, a crew run by crew mate ────────────────────────────────────────────────────────────── */

interface Who {
  name: string;
  /** Model and tool, or a crew mate's step and tool. */
  meta: string;
  mark: ReactNode;
}

interface GroupedProps {
  title: string;
  task: string;
  col: string;
  groups: FallGroup[];
  who: (lane: string) => Who;
  /** The second stat in tokens: the thread's turns, the crew's mates. */
  second: { k: string; v: string; s: string };
  /** Crew: its heaviest is a mate, not a turn. */
  heaviestGroup?: boolean;
  label: string;
  onClose: () => void;
  /** Go to this turn: scrolls the chat to it (the thread); none for a crew mate's turn in another chat. */
  go?: (t: FallTurn) => void;
  panel?: boolean;
  focus?: string;
}

type Line = { kind: "group"; g: FallGroup } | { kind: "turn"; g: FallGroup; t: FallTurn; n: number } | { kind: "sub"; t: FallTurn; i: number };

function GroupedFall({ title, task, col, groups, who, second, heaviestGroup = false, label, onClose, go, panel = false, focus: picked }: GroupedProps) {
  // The chart counts in price when the models have one (cost first), else tokens; the switch changes only the chart.
  const [mode, setMode] = useState<Mode>(() => (groups.some((g) => g.turns.some((t) => turnUsd(t) !== null)) ? "usd" : "tokens"));
  const { ref, close } = useCloser(onClose);
  const turns = groups.flatMap((g) => g.turns);
  const running = turns.some((t) => t.state === "running");
  const now = useNow(running ? 1000 : 30_000);
  const usdOf = (t: FallTurn) => turnUsd(t);
  const unpriced = turns.filter((t) => t.tokens && usdOf(t) === null);
  const anyPrice = turns.some((t) => usdOf(t) !== null);
  const priced = mode === "usd" && anyPrice;
  const val = (t: FallTurn) => (priced ? (usdOf(t) ?? 0) : t.tokens ? tokensTotal(t.tokens) : 0);
  const gval = (g: FallGroup) => g.turns.reduce((n, t) => n + val(t), 0);
  const total = groups.reduce((n, g) => n + gval(g), 0);
  const end = niceCeil(total);
  const all = turns.reduce<Tokens | null>((a, t) => (t.tokens ? (a ? { input: a.input + t.tokens.input, cacheWrite: a.cacheWrite + t.tokens.cacheWrite, cacheRead: a.cacheRead + t.tokens.cacheRead, output: a.output + t.tokens.output, reasoning: a.reasoning + t.tokens.reasoning } : t.tokens) : a), null);
  const heavy = turns.reduce<FallTurn | null>((h, t) => (val(t) > (h ? val(h) : 0) ? t : h), null);
  const heavyGroup = groups.reduce<FallGroup | null>((h, g) => (gval(g) > (h ? gval(h) : 0) ? g : h), null);
  const subsN = turns.reduce((n, t) => n + t.subs.length, 0);
  const fmt = (v: number) => (priced ? usd(v) : shortTokens(v));
  const ms = (t: { start: number; end: number | null }) => (t.end ?? now) - t.start;

  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  // A group picked from outside (the Captain page's crew): it open, the others folded; nothing picked, all open again.
  const lanesKey = groups.map((g) => g.lane).join("|");
  useEffect(() => {
    setFolded(picked ? new Set(groups.filter((g) => g.lane !== picked).map((g) => g.lane)) : new Set());
  }, [picked, lanesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hideSubs, setHideSubs] = useState<ReadonlySet<number>>(() => new Set());
  const [open, setOpen] = useState<number | null>(null);
  const lines: Line[] = [];
  for (const g of groups) {
    lines.push({ kind: "group", g });
    if (folded.has(g.lane)) continue;
    g.turns.forEach((t, n) => {
      lines.push({ kind: "turn", g, t, n });
      if (!hideSubs.has(t.seq)) t.subs.forEach((_, i) => lines.push({ kind: "sub", t, i }));
    });
  }
  const keyOf = (l: Line) => (l.kind === "group" ? `g:${l.g.lane}` : l.kind === "turn" ? `t:${l.t.seq}` : `s:${l.t.seq}:${l.i}`);
  const [focus, setFocus] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const at = Math.min(focus, lines.length - 1);
  const moveTo = (i: number) => {
    const n = Math.max(0, Math.min(lines.length - 1, i));
    setFocus(n);
    rowRefs.current.get(keyOf(lines[n]!))?.focus();
  };
  const toggleGroup = (lane: string) => setFolded((s) => (s.has(lane) ? new Set([...s].filter((x) => x !== lane)) : new Set([...s, lane])));
  const toggleSubs = (seq: number) => setHideSubs((s) => (s.has(seq) ? new Set([...s].filter((x) => x !== seq)) : new Set([...s, seq])));
  const key = (e: KeyboardEvent, i: number) => {
    const l = lines[i]!;
    if (e.key === "ArrowDown") return e.preventDefault(), moveTo(i + 1);
    if (e.key === "ArrowUp") return e.preventDefault(), moveTo(i - 1);
    if (e.key === "Home") return e.preventDefault(), moveTo(0);
    if (e.key === "End") return e.preventDefault(), moveTo(lines.length - 1);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (l.kind === "group") return folded.has(l.g.lane) ? toggleGroup(l.g.lane) : moveTo(i + 1);
      if (l.kind === "turn") return l.t.subs.length && hideSubs.has(l.t.seq) ? toggleSubs(l.t.seq) : setOpen(l.t.seq);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (l.kind === "group") return folded.has(l.g.lane) ? undefined : toggleGroup(l.g.lane);
      if (l.kind === "turn") {
        if (open === l.t.seq) return setOpen(null);
        if (l.t.subs.length && !hideSubs.has(l.t.seq)) return toggleSubs(l.t.seq);
        return moveTo(lines.findIndex((x) => x.kind === "group" && x.g.lane === l.g.lane));
      }
      return moveTo(lines.findIndex((x) => x.kind === "turn" && x.t.seq === l.t.seq));
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (l.kind === "group") return toggleGroup(l.g.lane);
      if (l.kind === "turn") return setOpen(open === l.t.seq ? null : l.t.seq);
    }
  };

  // Bars step across the whole: each group from where the one above ended, each turn from where the turn above it ended.
  const lefts = new Map<string, number>();
  let run = 0;
  for (const g of groups) {
    lefts.set(`g:${g.lane}`, run / end);
    for (const t of g.turns) (lefts.set(`t:${t.seq}`, run / end), (run += val(t)));
  }
  // The stats, whichever way the chart counts: the cost at list price, and what cost the most (else the most tokens).
  const costOf = (t: FallTurn) => (anyPrice ? (usdOf(t) ?? 0) : t.tokens ? tokensTotal(t.tokens) : 0);
  const costTotal = turns.reduce((n, t) => n + (usdOf(t) ?? 0), 0);
  const dearTurn = turns.reduce<FallTurn | null>((h, t) => (costOf(t) > (h ? costOf(h) : 0) ? t : h), null);
  const gcost = (g: FallGroup) => g.turns.reduce((n, t) => n + costOf(t), 0);
  const dearGroup = groups.reduce<FallGroup | null>((h, g) => (gcost(g) > (h ? gcost(h) : 0) ? g : h), null);
  const money = (v: number) => (anyPrice ? usd(v) : `${shortTokens(v)} tokens`);
  const dearName = heaviestGroup ? (dearGroup ? who(dearGroup.lane).name : "–") : dearTurn ? clip(dearTurn.ask || "A turn with no words", 22) : "–";
  const dearSub = heaviestGroup ? (dearGroup ? money(gcost(dearGroup)) : "") : dearTurn ? `${money(costOf(dearTurn))} · ${who(dearTurn.lane).name}` : "";

  return (
    <div
      ref={ref}
      className={panel ? "cwf cwf-panel" : "cwf"}
      tabIndex={-1}
      role="region"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") return e.stopPropagation(), close();
        // Opened, the card has the focus: the first arrow goes to its rows.
        if (e.target === e.currentTarget && (e.key === "ArrowDown" || e.key === "ArrowUp")) return e.preventDefault(), moveTo(0);
      }}
    >
      <div className="cwf-head">
        <b>{title}</b>
        {task && <span className="cwf-task">{task}</span>}
        <span className="cwf-grow" />
        <Switch mode={mode} onMode={setMode} />
        {running && <Live />}
      </div>
      {!turns.length ? (
        <div className="cwf-empty">
          <b>No turns yet</b>
          <span>Each turn shows here with its tokens once it starts.</span>
        </div>
      ) : (
        <>
          {/* Cost first, then tokens, then what cost the most; the switch changes only the chart (Arun, 2026-11-27). */}
          <div className="cwf-stats">
            <Stat
              k="Cost"
              live={running}
              v={anyPrice ? usd(costTotal) : "Unpriced"}
              s={!anyPrice ? "no list price for these models" : unpriced.length ? `at API price · ${unpriced.length} turn${unpriced.length > 1 ? "s" : ""} unpriced, not in it` : "at API price · on your plan it's included"}
            />
            <Stat k="Tokens" live={running} v={all ? shortTokens(tokensTotal(all)) : "–"} s={!all ? "none reported" : `${second.v} ${second.k.toLowerCase()} · ${shortTokens(inOf(all))} in · ${shortTokens(all.output)} out`} />
            <Stat k="Most costly" v={dearName} s={dearSub} />
          </div>
          <div className="cwf-cols" aria-hidden="true">
            <span>{col}</span>
            <Axis end={fmt(end)} />
            <span>In</span>
            <span>Out</span>
            <span>{priced ? "API price" : "Tokens"}</span>
            <span>Time</span>
          </div>
          <div className="cwf-rows" role="tree" aria-label={label}>
            {lines.map((l, i) => {
              const k = keyOf(l);
              const common = {
                ref: (el: HTMLDivElement | null) => void (el ? rowRefs.current.set(k, el) : rowRefs.current.delete(k)),
                tabIndex: i === at ? 0 : -1,
                onFocus: () => setFocus(i),
                onKeyDown: (e: KeyboardEvent) => key(e, i),
              };
              if (l.kind === "group") {
                const g = l.g;
                const w = who(g.lane);
                const v = gval(g);
                return (
                  <div key={k} {...common} className={`cwf-row cwf-grp${picked === g.lane ? " cwf-focus" : ""}`} role="treeitem" aria-level={1} aria-expanded={!folded.has(g.lane)} aria-label={`${w.name}, ${w.meta}: ${g.counted ? `${fmt(v)}${priced ? "" : " tokens"}` : "no tokens reported"}, ${took(g.turns.reduce((n, t) => n + ms(t), 0))}`} onClick={() => toggleGroup(g.lane)}>
                    <span className="cwf-nm">
                      <span className={folded.has(g.lane) ? "cwf-chev cwf-shut" : "cwf-chev"}>{CHEV}</span>
                      <span className="cwf-ic">{w.mark}</span>
                      <span className="cwf-t">{w.name}</span>
                      {w.meta && <span className="cwf-m">{w.meta}</span>}
                    </span>
                    <span className="cwf-track">{bar(lefts.get(k) ?? 0, v / end, "")}</span>
                    <span className="cwf-n">{g.counted ? shortTokens(inOf(g.tokens)) : "–"}</span>
                    <span className="cwf-n">{g.counted ? shortTokens(g.tokens.output) : "–"}</span>
                    <span className={g.counted ? "cwf-n ink" : "cwf-n dash"}>{g.counted ? fmt(v) : "–"}</span>
                    <span className="cwf-n">{took(g.turns.reduce((n, t) => n + ms(t), 0))}</span>
                  </div>
                );
              }
              if (l.kind === "turn") {
                const t = l.t;
                const v = val(t);
                const left = lefts.get(k) ?? 0;
                const isOpen = open === t.seq;
                const cls = t.state === "running" ? "cwf-run" : t.state === "failed" ? "cwf-fail" : "";
                const ask = t.ask || "A turn with no words";
                return [
                  <div key={k} {...common} className={`cwf-row${isOpen ? " cwf-open" : ""}${t.state === "running" ? " cwf-running" : ""}`} role="treeitem" aria-level={2} aria-expanded={isOpen} aria-label={`${ask}: ${t.tokens ? `${fmt(v)}${priced ? "" : " tokens"}` : "no tokens reported"}, ${took(ms(t))}${t.state === "failed" ? ", stopped on an error" : t.state === "running" ? ", running" : ""}`} onClick={() => setOpen(isOpen ? null : t.seq)}>
                    <span className="cwf-nm">
                      <span className="cwf-ind" />
                      <span
                        className={t.subs.length && hideSubs.has(t.seq) ? "cwf-chev cwf-shut" : "cwf-chev"}
                        onClick={t.subs.length ? (e) => (e.stopPropagation(), toggleSubs(t.seq)) : undefined}
                      >
                        {t.subs.length ? CHEV : null}
                      </span>
                      <span className="cwf-ic">{ASK_ICON}</span>
                      <span className="cwf-t">{t.state === "running" ? <Shine>{ask}</Shine> : ask}</span>
                      {heavy === t && turns.length > 1 && <span className="cwf-top">TOP</span>}
                    </span>
                    {/* A turn its tool counted no tokens for draws its time, thin, as a subagent does. */}
                    <span className="cwf-track">{t.tokens ? bar(left, Math.max(v / end, t.state === "running" ? 0.02 : 0), cls) : bar(left, 0.04, `cwf-time ${cls}`)}</span>
                    <span className="cwf-n">{t.tokens ? shortTokens(inOf(t.tokens)) : "–"}</span>
                    <span className="cwf-n">{t.tokens ? shortTokens(t.tokens.output) : "–"}</span>
                    <span className={t.tokens ? "cwf-n ink" : "cwf-n dash"}>{t.tokens && (!priced || usdOf(t) !== null) ? fmt(v) : "–"}</span>
                    <span className="cwf-n">{took(ms(t))}</span>
                  </div>,
                  isOpen && <TurnDetail key={`${k}:d`} t={t} go={go} />,
                ];
              }
              const t = l.t;
              const s = t.subs[l.i]!;
              const span = Math.max(1, ms(t));
              const tl = lefts.get(`t:${t.seq}`) ?? 0;
              const tw = Math.max(val(t) / end, 0.12);
              return (
                <div key={k} {...common} className="cwf-row cwf-sub" role="treeitem" aria-level={3} aria-label={`Subagent ${s.name}: its tokens are in its turn's, ${took(ms(s))}`}>
                  <span className="cwf-nm">
                    <span className="cwf-ind" />
                    <span className="cwf-ind" />
                    <span className="cwf-ind" />
                    <span className="cwf-ic">{SUB_ICON}</span>
                    <span className="cwf-t">{s.state === "running" ? <Shine>{s.name}</Shine> : s.name}</span>
                  </span>
                  <span className="cwf-track">{bar(tl + (tw * Math.max(0, s.start - t.start)) / span, Math.max(0.01, (tw * ms(s)) / span), `cwf-time${s.state === "running" ? " cwf-run" : s.state === "failed" ? " cwf-fail" : ""}`)}</span>
                  <span className="cwf-n">–</span>
                  <span className="cwf-n">–</span>
                  <span className="cwf-n dash">–</span>
                  <span className="cwf-n">{took(ms(s))}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="cwf-foot">
        <span>{priced ? "At each model's list price, as published" : subsN ? "Subagents run inside their agent's turn: their time shows, their tokens are in that turn" : "Each bar starts where the one above it ended"}</span>
        <span className="cwf-grow" />
        <kbd>↑</kbd>
        <kbd>↓</kbd>
        <kbd>→</kbd>
        <span>open</span>
      </div>
    </div>
  );
}

function TurnDetail({ t, go }: { t: FallTurn; go?: (t: FallTurn) => void }) {
  const k = t.tokens;
  const did = [t.steps ? `${t.steps} step${t.steps > 1 ? "s" : ""}` : "", t.subs.length ? `${t.subs.length} subagent${t.subs.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
  return (
    <div className="cwf-detail" role="group" aria-label="This turn">
      {k ? (
        <dl>
          <dt>Fresh in</dt>
          <dt>Cache read</dt>
          <dt>Cache write</dt>
          <dt>Out</dt>
          {k.reasoning > 0 && <dt>Reasoning</dt>}
          <dd>{shortTokens(k.input)}</dd>
          <dd>{shortTokens(k.cacheRead)}</dd>
          <dd>{shortTokens(k.cacheWrite)}</dd>
          <dd>{shortTokens(k.output)}</dd>
          {k.reasoning > 0 && <dd>{shortTokens(k.reasoning)}</dd>}
        </dl>
      ) : (
        <div>
          {toolWords(t.tool)} didn't report tokens for this turn. Its time is known: {took((t.end ?? Date.now()) - t.start)}.
        </div>
      )}
      <div>
        {t.ask ? `Asked: "${clip(t.ask, 200)}".` : "Nothing asked in words: it carried on by itself."}
        {did ? ` It took ${did}${t.model ? ` on ${modelWords(t.model)}` : ""}.` : t.model ? ` On ${modelWords(t.model)}.` : ""}
        {t.state === "failed" ? " It stopped on an error." : ""}
      </div>
      {go && (
        <div>
          <button type="button" className="cwf-go" onClick={() => go(t)}>
            Go to this turn
          </button>
        </div>
      )}
    </div>
  );
}

/* ── The thread card's Agents header ──────────────────────────────────────────────────────────────────────────────────────── */

export function ThreadFall({ state, events, subs: sent, who, go, onClose }: { state: SessionState; events: readonly SessionEvent[]; subs: readonly SubTask[]; /** Its name and mark, as the card shows the agent. */ who: (lane: string) => { name: string; mark: ReactNode }; go: (seq: number) => void; onClose: () => void }) {
  const groups = useMemo(() => groupsOf(turnsOf(events, state.engines, sent, undefined, 0, Infinity, (lane) => runOf(state, lane).status === "running")), [events, state, sent]);
  const turns = groups.reduce((n, g) => n + g.turns.length, 0);
  const subs = groups.reduce((n, g) => n + g.turns.reduce((m, t) => m + t.subs.length, 0), 0);
  const whoOf = (lane: string): Who => {
    const tool = state.engines[lane]?.tool;
    const model = modelWords(groups.find((g) => g.lane === lane)?.model);
    return { ...who(lane), meta: model || (tool ? ENGINE_NAMES[tool] : "") };
  };
  return (
    <GroupedFall
      title="Where this thread went"
      task={state.title}
      col="Turn"
      groups={groups}
      who={whoOf}
      second={{ k: "Turns", v: String(turns), s: [`${groups.length} agent${groups.length === 1 ? "" : "s"}`, subs ? `${subs} subagent${subs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") }}
      label="Where this thread's tokens went"
      onClose={onClose}
      go={(t) => (onClose(), requestAnimationFrame(() => go(t.seq)))}
    />
  );
}

/* ── A crew run in its room ───────────────────────────────────────────────────────────────────────────────────────────────── */

export function CrewFall({ run, events, engines, subs, go, onClose }: { run: RoomRun; events: readonly SessionEvent[]; engines: Engines; subs: readonly SubTask[]; go: (seq: number) => void; onClose: () => void }) {
  // The crew mates who have a step in it, by their lanes in the room: each mate's turns from where the run began to its end.
  const mates = useMemo(() => [...new Map(run.steps.filter((s) => s.lane && s.kind !== "approve").map((s) => [s.lane, s])).values()], [run.steps]);
  const last = run.ended ? (events.findLast((e) => e.ts <= run.ended!)?.seq ?? Infinity) : Infinity;
  const groups = useMemo(
    () => groupsOf(turnsOf(events, engines, subs, mates.map((m) => m.lane), run.seq0, last)),
    [events, engines, subs, mates, run.seq0, last],
  );
  const turns = groups.reduce((n, g) => n + g.turns.length, 0);
  const who = (lane: string): Who => {
    const m = mates.find((x) => x.lane === lane);
    const tool = (groups.find((g) => g.lane === lane)?.tool ?? engines[lane]?.tool) as EngineTool | undefined;
    const model = modelWords(groups.find((g) => g.lane === lane)?.model);
    return { name: m?.name ?? lane, meta: [model, tool ? ENGINE_NAMES[tool] : ""].filter(Boolean).join(" · "), mark: tool ? <EngineMark tool={tool} size={12} /> : <span className="cwf-dot" /> };
  };
  return (
    <GroupedFall
      title="Where this run went"
      task={run.name}
      col="Crew mate"
      groups={groups}
      who={who}
      second={{ k: "Crew", v: `${groups.length} mate${groups.length === 1 ? "" : "s"}`, s: `${turns} turn${turns === 1 ? "" : "s"}` }}
      heaviestGroup
      label="Where this run's tokens went"
      onClose={onClose}
      go={(t) => (onClose(), requestAnimationFrame(() => go(t.seq)))}
    />
  );
}

/* ── A Captain's page: its threads side by side ───────────────────────────────────────────────────────────────────────────── */

/** One thread's turns as /api/edits sends them, with its name and coding tool. */
export interface CaptainFallThread {
  sid: string;
  title: string;
  tool?: EngineTool;
  turns: FallTurn[];
}

/** Where a Captain's threads' tokens went, a thread to a row (CaptainPage.tsx's Cost), on the page rather than over it. */
export function CaptainFall({ project, threads, open, panel = false, focus }: { project: string; threads: readonly CaptainFallThread[]; open?: (sid: string) => void; /** Filling the Captain page's bottom panel: no card of its own, its rows the one scroll. */ panel?: boolean; /** The group (thread sid) picked on the page: open and marked, the rest folded. */ focus?: string }) {
  // Each thread is a group; a turn's place in its own log is made unique across threads, as the rows are keyed by it.
  const groups = useMemo(() => groupsOf(threads.flatMap((x, i) => x.turns.map((t) => ({ ...t, lane: x.sid, seq: i * 10_000_000 + t.seq })))), [threads]);
  const turns = groups.reduce((n, g) => n + g.turns.length, 0);
  const who = (sid: string): Who => {
    const x = threads.find((t) => t.sid === sid);
    const tool = (x?.tool ?? groups.find((g) => g.lane === sid)?.tool) as EngineTool | undefined;
    const model = modelWords(groups.find((g) => g.lane === sid)?.model);
    return { name: x?.title || "A thread", meta: [model, tool ? ENGINE_NAMES[tool] : ""].filter(Boolean).join(" · "), mark: tool ? <EngineMark tool={tool} size={12} /> : <span className="cwf-dot" /> };
  };
  return (
    <GroupedFall
      title="Where the crew's tokens went"
      // In the panel the page already names the project, and beside the title it ran into the stats under it at 900px.
      task={panel ? "" : project}
      col="Agent"
      groups={groups}
      who={who}
      second={{ k: "Agents", v: String(groups.length), s: `${turns} turn${turns === 1 ? "" : "s"}` }}
      heaviestGroup
      panel={panel}
      {...(focus ? { focus } : {})}
      label={`Where ${project}'s threads' tokens went`}
      onClose={() => {}}
      {...(open ? { go: (t: FallTurn) => open(t.lane) } : {})}
    />
  );
}
