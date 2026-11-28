import { awayFromApp } from "./prefs.js";

/**
 * When the app was last looked at, and the last time it went unlooked at for a while: what the Agent Board's "While you were
 * away" card is counted from (BoardAway.tsx; Arun, 2026-11-27, the board mock's smaller pieces).
 *
 * "Looked at" is the app's one meaning of it, the same that decides whether a notification is worth raising (prefs.ts
 * awayFromApp): the window showing and in front. Kept on this computer, so quitting in the evening and opening in the morning
 * is a night away, not a fresh start. No server and no reading of anything: a stamp every half minute while you look, none while
 * you don't.
 */

/** Unlooked at this long is "away": shorter and the card would greet every coffee. */
export const AWAY_MS = 30 * 60_000;
const KEY = "friday.seen";
const EVERY_MS = 30_000;

export interface Seen {
  /** The last moment the app was being looked at. */
  at: number;
  /** The latest stretch it wasn't, of AWAY_MS or more, until its card is dismissed or a later stretch takes its place. */
  away?: { from: number; to: number };
}

/** The record after a look at `now`: a gap of `after` or more since the last look is a stretch away, kept until dismissed. */
export function seenStep(s: Seen | null, now: number, after = AWAY_MS): Seen {
  if (!s || !(s.at > 0) || s.at > now) return { at: now };
  if (now - s.at >= after) return { at: now, away: { from: s.at, to: now } };
  return s.away ? { at: now, away: s.away } : { at: now };
}

const read = (): Seen | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Seen | null;
    return v && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
};

let cur: Seen | null = null;
let away: Seen["away"] | null = null;
const subs = new Set<() => void>();
function keep(next: Seen) {
  cur = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* remembered for this visit only */
  }
  // The same stretch read again is the same object, so nothing that shows it draws again for a stamp.
  const a = next.away ?? null;
  if (a?.from === away?.from && a?.to === away?.to) return;
  away = a;
  subs.forEach((f) => f());
}

let looking = false;
/** The stretch's card has been on screen since the app was last come back to (BoardAway.tsx). */
let shown = 0;
export const awayShown = (): void => void (shown ||= Date.now());
/** On screen at least this long counts as shown: a window that lost the focus as the card drew hasn't shown it to anyone. */
const SHOWN_MS = 5000;
function look() {
  const now = Date.now();
  const was = looking;
  looking = !awayFromApp();
  // Read each time: the app's other windows (a Captain's, Code's) keep the same record.
  if (looking) keep(seenStep(read() ?? cur, now));
  // Just left: looked at until now, so the stretch away starts here and not at the last half-minute stamp. A stretch whose card was
  // on screen this visit goes with it: it is shown once.
  else if (was) {
    const s = read() ?? cur;
    const seenIt = shown > 0 && now - shown >= SHOWN_MS;
    keep(s?.away && !seenIt ? { at: now, away: s.away } : { at: now });
    shown = 0;
  }
}

// Not the menu bar's panel or the quick prompt's window: a glance at those is not a look at the app.
const QUIET = typeof location !== "undefined" && /^(tray|quick)$/.test(new URLSearchParams(location.search).get("view") ?? "");
if (typeof document !== "undefined" && typeof localStorage !== "undefined" && !QUIET) {
  cur = read();
  away = cur?.away ?? null;
  look();
  for (const e of ["focus", "blur", "pageshow", "pagehide"]) addEventListener(e, look);
  document.addEventListener("visibilitychange", look);
  setInterval(look, EVERY_MS);
}

/** The stretch away that hasn't been dismissed, or null. The same object until it changes (useSyncExternalStore). */
export const awayNow = (): Seen["away"] | null => away;
export const onAway = (f: () => void): (() => void) => (subs.add(f), () => void subs.delete(f));
/** Read, or shown and left: gone until the app next goes unlooked at for a while. */
export function dismissAway(): void {
  const s = read() ?? cur;
  if (s?.away) keep({ at: s.at });
}
