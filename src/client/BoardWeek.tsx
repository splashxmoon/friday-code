import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { WeekStats } from "../board.js";
import "./board-week.css";

/**
 * The board's week as numbers that move (Arun, 2026-11-27, the Agent Board mock's "The week, as numbers that move"; affectUI's
 * Stat Card and Trend Chart): what shipped, how many runs, and how long agents waited on you before an answer, each with its
 * last seven days as a line and the change on the seven before. It folds to one row, and stays as it was left.
 *
 * Every number is the server's (board.ts weekStats), read from the sessions' own logs. A week with nothing in it and nothing
 * before it draws nothing at all: three zeros say less than no row.
 */

const FOLD = "mpa.board.week";
const folded = (): boolean => {
  try {
    return localStorage.getItem(FOLD) === "0";
  } catch {
    return false;
  }
};

/** A wait, said short: 42s, 7m, 1h 20m, 2d. */
export function waitWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

type Tone = "good" | "bad" | "quiet";
interface Stat {
  key: string;
  label: string;
  value: string;
  /** The change on last week, in words, and whether it is good news. */
  change: string;
  tone: Tone;
  /** The last seven days, oldest first; null where a day has nothing to plot. */
  days: (number | null)[];
  /** What the line is, for a screen reader. */
  said: string;
}

const W = 100;
const H = 22;
/** The line's points in a 100 by 22 box, a hair inside its top and bottom so the stroke isn't cut. A day with nothing is skipped. */
export function sparkPath(days: (number | null)[]): string {
  const known = days.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (!known.length) return "";
  const max = Math.max(...known.map((p) => p.v));
  const min = Math.min(...known.map((p) => p.v));
  const x = (i: number) => (days.length > 1 ? (i / (days.length - 1)) * W : W / 2);
  // All the same (a week of zeros, one answer): a level line, low for nothing and mid for something.
  const y = (v: number) => (max === min ? (max === 0 ? H - 2 : H / 2) : H - 2 - ((v - min) / (max - min)) * (H - 4));
  // One day alone is a dot: a line of no length, drawn by its round ends.
  if (known.length === 1) return `M${x(known[0]!.i).toFixed(1)} ${y(known[0]!.v).toFixed(1)}h.01`;
  return known.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** The cards a week has: Shipped and Runs always, Waited on you only when you answered something this week. */
export function statsOf(week: WeekStats): Stat[] {
  const count = (key: string, label: string, now: number, before: number, days: number[], each: string, long: boolean): Stat => {
    const d = now - before;
    return { key, label, value: String(now), change: d === 0 ? "Same as last week" : `${signed(d)}${long ? " on last week" : ""}`, tone: d > 0 ? "good" : d < 0 ? "bad" : "quiet", days, said: `${each} each day, the last 7 days, oldest first: ${days.join(", ")}` };
  };
  const out = [count("shipped", "Shipped", week.shipped, week.before.shipped, week.days.shipped, "Sessions that shipped", true), count("runs", "Runs", week.runs, week.before.runs, week.days.runs, "Runs", false)];
  if (week.waited !== null) {
    const was = week.before.waited;
    const d = was === null ? 0 : week.waited - was;
    // Under a second either way is the same wait.
    const same = Math.abs(d) < 1000;
    out.push({
      key: "waited",
      label: "Waited on you",
      value: waitWords(week.waited),
      // Shorter is the good news here.
      change: was === null ? `median of ${week.answers} answer${week.answers === 1 ? "" : "s"}` : same ? "median, same as last week" : `median, ${d < 0 ? "down" : "up"} ${waitWords(Math.abs(d))}`,
      tone: was === null || same ? "quiet" : d < 0 ? "good" : "bad",
      days: week.days.waited,
      said: `Median wait each day, the last 7 days, oldest first: ${week.days.waited.map((v) => (v === null ? "none" : waitWords(v))).join(", ")}`,
    });
  }
  return out;
}

/** Whether there is a week to show: anything this week or the one before. An older server's three numbers alone have no days to draw. */
export const hasWeek = (week: WeekStats | null): week is WeekStats => !!week && !!week.days && !!week.before && (week.shipped > 0 || week.runs > 0 || week.waited !== null || week.before.shipped > 0 || week.before.runs > 0 || week.before.waited !== null);

export default function BoardWeek({ week }: { week: WeekStats | null }) {
  const [open, setOpen] = useState(() => !folded());
  if (!hasWeek(week)) return null;
  const stats = statsOf(week);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(FOLD, next ? "1" : "0");
    } catch {
      // Blocked storage: it folds for this visit.
    }
  };
  return (
    <section className="bwk" aria-label="This week" data-testid="board-week" data-open={open}>
      <button type="button" className="bwk-fold" aria-expanded={open} aria-controls="bwk-cards" onClick={toggle}>
        <ChevronRightIcon className="bwk-chev" aria-hidden />
        <span className="bwk-title">This week</span>
        {/* Folded, the same numbers on one line. */}
        {!open && (
          <span className="bwk-line">
            {stats.map((s) => (
              <span key={s.key} className="bwk-bit">
                <b>{s.value}</b> {s.key === "waited" ? "median wait" : s.label.toLowerCase()}
                {s.key !== "waited" && s.tone !== "quiet" && <em data-tone={s.tone}>{s.change.replace(" on last week", "")}</em>}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div id="bwk-cards" className="bwk-cards" style={{ ["--bwk-n" as string]: stats.length }}>
          {stats.map((s) => (
            <div key={s.key} className="bwk-card" data-stat={s.key}>
              <span className="bwk-k">{s.label}</span>
              <span className="bwk-v">{s.value}</span>
              <span className="bwk-s" data-tone={s.tone}>
                {s.change}
              </span>
              <svg className="bwk-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={s.said}>
                <path d={sparkPath(s.days)} data-dot={s.days.filter((v) => v !== null).length === 1 || undefined} />
              </svg>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
