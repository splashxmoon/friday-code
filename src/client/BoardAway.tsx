import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BoardCard } from "../board.js";
import type { Need } from "../needs-rank.js";
import { Button } from "@/components/affect/button";
import { awayNow, awayShown, dismissAway, onAway } from "./seen.js";
import "./board-away.css";

/** Back this long without opening the board: the stretch away is old news, and its card isn't shown late. */
const STALE_MS = 60 * 60_000;

/** A run that ended badly, as the board's cards say it (board.ts boardCards, applyPrStatus). */
const FAILED = new Set(["Stopped", "CI failed", "Merge conflicts"]);

export interface AwayFacts {
  /** Handed over while you were gone: in review, ready, or merged. */
  finished: BoardCard[];
  /** Stopped with an error, or its pull request's checks or merge failing, while you were gone. */
  failed: BoardCard[];
  /** Everything waiting on you now. */
  waiting: Need[];
  /** When the one waiting longest began to. */
  oldest: number;
  /** Whether any of it happened in the stretch away: nothing did, no card. */
  any: boolean;
}

/**
 * What the board says happened between `from` and `to`, from its cards' own times and columns and what waits on you: nothing is
 * read for it and nothing is guessed. A card counts when its agent last moved in that stretch; what waits counts whenever it began,
 * since it still waits, but only something from the stretch itself makes a card worth showing.
 */
export function awayFacts(cards: readonly BoardCard[], needs: readonly Need[], from: number, to: number): AwayFacts {
  const then = cards.filter((c) => c.at >= from && c.at <= to);
  const failed = then.filter((c) => FAILED.has(c.status));
  const finished = then.filter((c) => !FAILED.has(c.status) && (c.column === "review" || c.column === "ready" || c.status === "Merged"));
  const waiting = needs.filter((n) => !n.putOff);
  const oldest = waiting.length ? Math.min(...waiting.map((n) => n.since)) : 0;
  return { finished, failed, waiting, oldest, any: finished.length + failed.length + waiting.filter((n) => n.since >= from && n.since <= to).length > 0 };
}

/** "2h 14m", "45m", "3d 4h": how long, short. */
export function awaySpan(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** "12 minutes", "2 hours", "3 days": how long something has waited, in words. */
export function waitWords(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const n = (v: number, w: string) => `${v} ${w}${v === 1 ? "" : "s"}`;
  if (m < 1) return "under a minute";
  if (m < 60) return n(m, "minute");
  if (m < 48 * 60) return n(Math.floor(m / 60), "hour");
  return n(Math.floor(m / 1440), "day");
}

const clip = (s: string, n = 44) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
/** The first two by name, then how many more. */
const some = (said: string[]) => (said.length > 2 ? `${said.slice(0, 2).join(", ")} and ${said.length - 2} more` : said.join(", "));
const stands = (c: BoardCard) => (c.status === "Merged" ? "merged" : c.column === "review" ? "is in review" : c.status === "Ready to merge" ? "is ready to merge" : "is ready");

/**
 * While you were away (Arun, 2026-11-27, the Agent Board mock's smaller pieces; the shared kit's Away Summary and Agent Recap):
 * a card at the top of the board when you come back after half an hour or more of not looking at the app (seen.ts), saying how
 * long, what finished, what failed and what waits on you with how long the oldest has, and Start with what waits, which goes to
 * the first of them. Shown for the visit you came back on: Dismiss, Start, or looking away again takes it for good, and with
 * nothing to say it is never drawn.
 */
export default function BoardAway({ cards, needs, onStart }: { cards: BoardCard[]; needs: Need[]; onStart: () => void }) {
  const away = useSyncExternalStore(onAway, awayNow, () => null);
  const facts = useMemo(() => (away ? awayFacts(cards, needs, away.from, away.to) : null), [away, cards, needs]);
  const stale = !!away && Date.now() - away.to > STALE_MS;
  const show = !!away && !stale && !!facts?.any;
  useEffect(() => {
    if (stale) dismissAway();
    else if (show) awayShown();
  }, [stale, show]);
  if (!show || !away || !facts) return null;
  const { finished, failed, waiting, oldest } = facts;
  return (
    <section className="bd-away" aria-label="While you were away" data-testid="board-away">
      <h2 className="bd-away-h">
        While you were away <span className="tabular-nums">{awaySpan(away.to - away.from)}</span>
      </h2>
      <ul>
        {finished.length > 0 && (
          <li>
            <b>{finished.length} finished:</b> {some(finished.map((c) => `${clip(c.title)} ${stands(c)}`))}
          </li>
        )}
        {failed.length > 0 && (
          <li>
            <b>{failed.length} failed:</b> {some(failed.map((c) => `${clip(c.title)}, ${lower(c.detail || c.status)}`))}
          </li>
        )}
        {waiting.length > 0 && (
          <li>
            <b>{waiting.length} waiting on you,</b> {waiting.length > 1 ? "the oldest " : ""}for {waitWords(Date.now() - oldest)}
          </li>
        )}
      </ul>
      <div className="bd-away-acts">
        {waiting.length > 0 && (
          <Button size="sm" onClick={() => (dismissAway(), onStart())}>
            Start with what waits
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={dismissAway}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
