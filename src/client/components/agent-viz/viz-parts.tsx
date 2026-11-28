// The small parts the four agent pictures share (Agent Crew, Agent Handoff, Agent Monitor, Agent Fleet: affectUI Pro's, rebuilt
// by hand from their public previews, Arun 2026-11-27: "i want to do cool stuff like this"): an agent's pixel mark, its tile, its
// status chip, the spinner and the shared clock. Every one of them is drawn in Friday's tokens (agent-viz.css).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { tickEvery } from "../../presence.js";

/** Where an agent stands, the one word every picture goes by. */
export type VizStatus = "working" | "needs" | "done" | "idle" | "failed" | "queued";
/** An agent's colour: Friday's own tints (agent-viz.css), never a colour for its state. */
export type VizColor = "blue" | "purple" | "cyan" | "green" | "orange" | "pink";
/** A tool an agent used: its mark (a coding tool's logo, a step's icon) and its name for the tooltip. */
export interface VizTool {
  id: string;
  label: string;
  mark: ReactNode;
}

export const COLORS: VizColor[] = ["blue", "purple", "cyan", "green", "orange", "pink"];
/** A steady colour for a name, so an agent keeps its colour from one look to the next. */
export function colorOf(seed: string): VizColor {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
}

const WORD: Record<VizStatus, string> = { working: "Working", needs: "Needs you", done: "Done", idle: "Idle", failed: "Failed", queued: "Up next" };
export const statusWord = (s: VizStatus, words?: Partial<Record<VizStatus, string>>) => words?.[s] ?? WORD[s];

/** The 0.9s turning arc of anything at work, in the live colour. */
export function VizSpinner({ size = 12 }: { size?: number }) {
  return (
    <svg className="viz-spin fi" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

const ICON: Partial<Record<VizStatus, ReactNode>> = {
  done: (
    <svg className="fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.3l2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  needs: (
    <svg className="fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" />
      <path d="M6 3.6V6l1.6 1" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
  failed: (
    <svg className="fi" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.8l4.6 8H1.4z" fill="none" stroke="currentColor" strokeLinejoin="round" />
      <path d="M6 5v2M6 8.4v.1" stroke="currentColor" strokeLinecap="round" />
    </svg>
  ),
};

/**
 * A status chip: 18 tall at radius 4 with its 12px mark (the spinner while it works), 11/500 text on a tint of its own colour; the
 * idle one a quiet dot on the ink's 6%. `bare` draws the mark alone in an 18px tile, as a sub-agent's card has it.
 */
export function VizChip({ status, words, bare }: { status: VizStatus; words?: Partial<Record<VizStatus, string>>; bare?: boolean }) {
  const mark = status === "working" ? <VizSpinner /> : ICON[status] ?? <i className="viz-chip-dot" aria-hidden="true" />;
  if (bare)
    return (
      <span className="viz-chip bare" data-s={status} role="img" aria-label={statusWord(status, words)} title={statusWord(status, words)}>
        {mark}
      </span>
    );
  return (
    <span className="viz-chip" data-s={status}>
      {mark}
      {statusWord(status, words)}
    </span>
  );
}

/** A 3×3 pattern of lit squares, steady for a seed: never fewer than five lit, so the mark always reads. */
function patternOf(seed: string): boolean[] {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  const cells = Array.from({ length: 9 }, (_, i) => ((h >> i) & 1) === 1 || i === 4);
  for (let i = 0; cells.filter(Boolean).length < 5; i += 2) cells[i % 9] = true;
  return cells;
}

/**
 * An agent's pixel mark: a 3×3 grid of 3px squares at radius .75, 1.5 apart, in its colour; unlit squares at a quarter. While it
 * works the squares twinkle in a wave along the diagonal (1.2s, .12s apart).
 */
export function PixelMark({ seed, color, working }: { seed: string; color: VizColor; working?: boolean }) {
  const lit = patternOf(seed);
  return (
    <span className="viz-px" data-c={color} data-working={working || undefined} aria-hidden="true">
      {lit.map((on, i) => (
        <i key={i} className={on ? "on" : ""} style={{ "--d": `${((i % 3) + Math.floor(i / 3)) * 0.12}s` } as CSSProperties} />
      ))}
    </span>
  );
}

/** A tile on the card's ring: 22 (crew, fleet), 26 (monitor, handoff), 24 (a step), 18 or 16 (a tool) px, its mark centred. */
export function Tile({ size, children, className = "", title }: { size: 16 | 18 | 22 | 24 | 26; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`viz-tile s${size} ${className}`} title={title}>
      {children}
    </span>
  );
}

/** Tool tiles in a row (16px, 10px marks), each named on hover. */
export function ToolRow({ tools, max = 4, stacked }: { tools: VizTool[]; max?: number; stacked?: boolean }) {
  if (!tools.length) return null;
  return (
    <span className={stacked ? "viz-tools stacked" : "viz-tools"}>
      {tools.slice(0, max).map((t) => (
        <Tile key={t.id} size={16} title={t.label}>
          {t.mark}
        </Tile>
      ))}
    </span>
  );
}

/** "58k", "960", "1.2M": a token count as the context bars say it. */
export function tokensShort(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** "$0.31", "$4.12", "$0.024" under a cent: what an agent has cost, as exact as it needs to be. */
export function usd(n: number): string {
  if (n > 0 && n < 0.1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** "0:04", "12:05", "1:02:10": a step's clock. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "2.3s", "41s", "3m 04s": how long a finished step took. */
export function tookOf(ms: number): string {
  if (ms < 10_000) return `${Math.max(0.1, Math.round(ms / 100) / 10)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The page's shared ticker, every second while `on`: clocks that move only while something works. */
export function useTick(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (on ? tickEvery(ms, setNow) : undefined), [on, ms]);
  return now;
}

/** Whether motion is off: the system's setting or the app's own (html.reduce-motion). */
export function useReducedMotion(): boolean {
  const read = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || (typeof document !== "undefined" && document.documentElement.classList.contains("reduce-motion"));
  const [off, setOff] = useState(read);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setOff(read());
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return off;
}
