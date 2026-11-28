import { lazy, Suspense } from "react";

/**
 * Friday's first launch (Arun, 2026-11-26: "when the app loads there is a friday logo and blank screen... i want to recreate that on
 * first download... text appears like it is typing... a friday logo animation with crew mascots and stuff be very creative and
 * fun", then of the recorded take: no cursor first, the logo assembling on load, no ring). Mock and recordings in Friday Work HQ
 * product/designs/2026-11-26-intro.
 *
 * On the app's own blank ground: the mark's three pieces arrive and meet, "Hi, I'm Friday." types under it, the mark parts and
 * the crew tumble out asleep, wake one by one, each catches a coding tool, a wave down the line, and they settle into the welcome
 * sheet's faces (Setup.tsx), which this hands on to. Once, for someone new on their own computer; Skip or Escape ends it.
 */

const SEEN = "friday.intro.seen";
const seen = (): boolean => {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return true;
  }
};
export const markSeen = () => {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {}
};

/**
 * Due: someone who hasn't been welcomed or seen it, with motion allowed. Not under test automation, which drives the welcome
 * straight away (the e2e suite), unless the address asks for it (?intro=1, which also plays it again for anyone).
 */
export function introDue(welcomed: boolean): boolean {
  if (typeof window === "undefined") return false;
  const asked = new URLSearchParams(location.search).get("intro") === "1";
  if (asked) return true;
  if (welcomed || seen()) return false;
  if (navigator.webdriver) return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The play itself (FirstLaunchPlay.tsx) loads only when it is due: it is seen once, by someone new, and the first screen is held
 * to a budget (test/client-bundle.test.ts) that a one-time animation shouldn't spend.
 */
const Play = lazy(() => import("./FirstLaunchPlay.js").then((m) => ({ default: m.FirstLaunchPlay })));
export function FirstLaunch(p: { onHandOff: () => void; onDone: () => void }) {
  return (
    <Suspense fallback={<div className="fl" aria-hidden />}>
      <Play {...p} />
    </Suspense>
  );
}
