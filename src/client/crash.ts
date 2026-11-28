import { useEffect, useState } from "react";

/**
 * When the app itself can't be drawn: what went wrong, said plainly, with Reload, instead of a blank window (Arun, 2026-11-01:
 * "production screen app is blank after reloading for update"). React leaves the root empty after an error nothing caught;
 * this draws into it with the DOM alone, so it shows even when the app's own components are what failed. The error's own
 * words and the first lines of its stack, so a screenshot of it says where.
 *
 * Go home beside Reload (spec 13; Arun, 2026-11-24: "Go all out and fix these problems"): Reload opens the same page, and a
 * page that can't be drawn (a session whose log breaks it) failed again the moment it came back. Home is the page without
 * the session in its address. Failing again within seconds of a Reload is a loop, said so, with Go home first.
 */
export function showCrash(error: unknown): void {
  // After React has taken its tree down: drawn before, it was cleared with the rest.
  setTimeout(() => draw(error), 0);
}

/** Set as Reload is pressed, so the page it opens knows it came from this screen. */
const RELOADED = "friday.crash.reloaded";
/** Failing again this soon after a Reload from this screen is a loop. */
const LOOP_MS = 10_000;

function store(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this page was opened by the crash screen's Reload (or the window's own) and failed within seconds of opening. */
export function crashLoop(o: { sinceLoad: number; reloadedAt: number | null; reloadNav: boolean; now: number }): boolean {
  if (o.sinceLoad > LOOP_MS) return false;
  if (o.reloadedAt !== null) return o.now - o.reloadedAt < LOOP_MS + 5_000;
  return o.reloadNav;
}

function looping(): boolean {
  const s = store();
  const raw = s?.getItem(RELOADED);
  const at = raw ? Number(raw) : null;
  let nav = false;
  try {
    nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
  } catch {}
  return crashLoop({ sinceLoad: performance.now(), reloadedAt: Number.isFinite(at) ? at : null, reloadNav: nav, now: Date.now() });
}

/** The app's home: its address without a session, a view or anything else after it (App.tsx routeUrl). */
export const homeUrl = (origin: string): string => `${origin}/`;

function draw(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const loop = looping();
  // The kit's card with its empty state's tile at the head: a 42px tile with the mark, the title 15/500/24, what happened in
  // muted 13/20, the stack in a code well, and a 44px foot over a hairline, Copy the error at its start and the way out at its
  // end, the primary last. Drawn with inline styles: the app's own components may be what failed, the stylesheet with them.
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.className = "crash-screen";
  box.style.cssText = "box-sizing:border-box;width:min(560px,calc(100% - 32px));margin:15vh auto 0;border-radius:10px;background:var(--card, #1f1f1f);box-shadow:var(--aui-shadow-card, 0 0 0 1px rgb(127 127 127 / .2));font:13px/20px var(--font, system-ui);color:var(--ink, #ededed);overflow:hidden;animation:ch-dialog-in .24s cubic-bezier(.22,1,.36,1) both";
  const body = document.createElement("div");
  body.style.cssText = "padding:20px 20px 16px";
  const tile = document.createElement("div");
  tile.setAttribute("aria-hidden", "true");
  tile.style.cssText = "display:grid;place-items:center;width:42px;height:42px;border-radius:11px;margin-bottom:16px;background:color-mix(in srgb, var(--red, #ef5b5b) 12%, transparent);color:var(--red, #ef5b5b)";
  tile.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>';
  const title = document.createElement("div");
  title.textContent = loop ? "Friday couldn't draw this screen again" : "Friday couldn't draw this screen";
  title.style.cssText = "font-size:15px;line-height:24px;font-weight:500;text-wrap:balance";
  const what = document.createElement("div");
  what.textContent = loop ? "It stopped again right after reloading. Go home to start from a clean page; your sessions are safe." : e.message || "Something went wrong.";
  what.style.cssText = "color:var(--text-muted, #929292);margin:4px 0 14px;overflow-wrap:anywhere";
  const stack = document.createElement("pre");
  // The stack's first line is the message, in Chromium; said once, above it, only where it isn't.
  const lines = (e.stack ?? "").split("\n").slice(0, 6);
  stack.textContent = [loop && !lines[0]?.includes(e.message) ? e.message : "", ...lines].filter(Boolean).join("\n");
  stack.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px var(--mono, ui-monospace, monospace);color:var(--text-muted, #929292);background:color-mix(in srgb, var(--ink, #ededed) 3%, transparent);box-shadow:inset 0 0 0 .5px var(--border-strong, rgb(127 127 127 / .3));border-radius:8px;padding:8px 12px;margin:0;max-height:40vh;overflow:auto";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;height:44px;box-sizing:border-box;padding:0 8px 0 12px;border-top:1px solid var(--border, rgb(127 127 127 / .2))";
  const button = (label: string, kind: "primary" | "secondary" | "ghost", act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    const look =
      kind === "primary"
        ? "background:var(--accent, #ededed);color:var(--on-accent, #141414);box-shadow:none"
        : kind === "secondary"
          ? "background:var(--card, #1f1f1f);color:var(--ink, #ededed);box-shadow:0 0 0 .5px var(--border-strong, rgb(127 127 127 / .35)),0 1px 2px rgb(0 0 0 / .08)"
          : "background:none;color:var(--text-muted, #929292);box-shadow:none;margin-right:auto";
    b.style.cssText = `height:28px;padding:0 10px;border:0;border-radius:6px;font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;${look}`;
    b.onclick = act;
    return b;
  };
  const reload = () => {
    store()?.setItem(RELOADED, String(Date.now()));
    location.reload();
  };
  const home = () => {
    store()?.removeItem(RELOADED);
    location.assign(homeUrl(location.origin));
  };
  const copy = () => void navigator.clipboard?.writeText(`${e.message}\n${e.stack ?? ""}`).catch(() => {});
  row.append(
    button("Copy the error", "ghost", copy),
    // The one to press ends the row: Reload the first time, Go home in a loop.
    ...(loop ? [button("Reload", "secondary", reload), button("Go home", "primary", home)] : [button("Go home", "secondary", home), button("Reload", "primary", reload)]),
  );
  body.append(tile, title, what, stack);
  box.append(body, row);
  root.replaceChildren(box);
}

/** What a page the e2e suite marked (`window.__fridayE2E`) can be asked to do: fail at its root, to show this screen. */
type E2EWindow = Window & { __fridayE2E?: boolean; __fridayE2ECrash?: () => void };

/**
 * Nothing at all, except on a page the e2e suite marked before it loaded (e2e/local-guard.spec.ts): there, `__fridayE2ECrash()`
 * makes the root fail as a real crash would, so the crash screen can be checked. No production page is ever marked.
 */
export function CrashForTests() {
  const [boom, setBoom] = useState<Error | null>(null);
  useEffect(() => {
    const w = window as E2EWindow;
    if (w.__fridayE2E === true) w.__fridayE2ECrash = () => setBoom(new Error("The e2e suite asked the page to fail"));
  }, []);
  if (boom) throw boom;
  return null;
}
