import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";

/**
 * This install's key: what every request to Friday on this computer must carry (app.ts, the open-source edition).
 *
 * Friday here has no sign-in, and what reaches it can start coding tools and open a terminal. It answers 127.0.0.1 only and
 * turns away other sites' pages (app.ts localOnly), but a program needs neither: anything on the computer could connect and say
 * it was Friday's own page. So another account on a shared computer, a container on the host's network, or an app kept in a
 * sandbox had a shell as this person (security audit 2026-11-27, server H2). Now each request carries this key, which is in a
 * file only this person's account can read (0600, as outside-mcp.ts keeps its token):
 *
 * - Friday's own window is given it as a cookie by the app itself (desktop.ts), never in an address.
 * - A browser is let in by a link that works once and for a few minutes (`enterLink`), which the command opens and prints; the
 *   page it lands on trades it for the cookie. The link's pass is in the part of an address a browser never sends (after #), so
 *   it is in no request line and no log.
 * - Programs of Friday's own (its runners, the phone's listener, a computer linked to it) send it as a header.
 *
 * What it does not stop: a program running as this same person can read the file, as it can read everything else of theirs.
 */

export const KEY_FILE = "local-key";
export const KEY_HEADER = "x-friday-key";
/** Cookies are kept by host and not by port, and two Fridays (another folder's, a host's through its tunnel) share 127.0.0.1: one each. */
export const keyCookie = (port: number | string) => `friday_key_${port}`;

/** This install's key, made the first time and kept to its owner alone. */
export function localKey(home: string): string {
  const file = path.join(home, KEY_FILE);
  mkdirSync(home, { recursive: true });
  // One cut short as it was first written is made again: an empty key would let everything in.
  const kept = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (kept.length < 32) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  // A copy put back by hand, or a folder restored, may come with its mode wider than this person: narrowed again.
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

/** The key beside a Friday already running, for a second start that only opens it (start.ts `already`). "" when it has none. */
export function keptKey(home: string): string {
  try {
    return readFileSync(path.join(home, KEY_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Whether a request carries this install's key: as the header a program sends, or the cookie a page was given. */
export function hasKey(req: Pick<http.IncomingMessage, "headers">, key: string, port: number | string): boolean {
  if (!key) return false;
  const header = req.headers[KEY_HEADER];
  if (typeof header === "string" && same(header, key)) return true;
  const name = keyCookie(port);
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name && same(part.slice(at + 1).trim(), key)) return true;
  }
  return false;
}

/** The cookie a page keeps the key in: never read by a script, and never sent with a request another site started. */
export const keyCookieHeader = (key: string, port: number | string) => `${keyCookie(port)}=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;

const TICKET_MAX_MS = 15 * 60_000;
const mac = (key: string, body: string) => createHmac("sha256", key).update(`friday-enter:${body}`).digest("base64url");

/**
 * A pass into Friday for a browser: good once, for a few minutes, made by whoever can read the key (the command, the app).
 * It is not the key: seen after it was used, or after its time, it opens nothing.
 */
export function mintTicket(key: string, ttlMs = 5 * 60_000, now = Date.now()): string {
  const body = `${randomBytes(12).toString("base64url")}.${now + Math.min(ttlMs, TICKET_MAX_MS)}`;
  return `${body}.${mac(key, body)}`;
}

/** The passes already used, kept until their time is up, so each works once. */
export class Tickets {
  private readonly used = new Map<string, number>();
  constructor(private readonly key: string) {}

  /** Whether this pass is this install's, in time and not used before. Using it spends it. */
  take(ticket: unknown, now = Date.now()): boolean {
    if (typeof ticket !== "string" || ticket.length > 200) return false;
    const [nonce, exp, sig, ...rest] = ticket.split(".");
    if (!nonce || !exp || !sig || rest.length) return false;
    const until = Number(exp);
    if (!same(sig, mac(this.key, `${nonce}.${exp}`))) return false;
    if (!Number.isFinite(until) || until < now || until > now + TICKET_MAX_MS + 60_000) return false;
    for (const [n, t] of this.used) if (t < now) this.used.delete(n);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, until);
    return true;
  }
}

/**
 * What still answers without the key, each because it checks a credential of its own or holds nothing of the person's:
 * the app's own files (the same for everyone; a page's manifest and icons are asked for without cookies), whether this is
 * Friday and how a host is (start.ts, hosts.ts), an agent outside Friday (its token, outside-mcp.ts), a webhook (its key), an
 * MCP sign-in coming back from the person's browser (its one-time state; it arrives from another site, so without the cookie),
 * and what a frame with no origin of its own reads, which a browser sends no cookie for: a made page's pictures (their pass,
 * work-frame.ts) and a backdrop's files.
 */
export function keylessRoute(method: string, pathname: string, query: URLSearchParams): boolean {
  const read = method === "GET" || method === "HEAD";
  if (!pathname.startsWith("/api/")) {
    if (method === "GET" && pathname === "/callback" && query.has("state")) return true;
    return read && /\.[a-z0-9]{1,12}$/i.test(pathname) && !/\.html?$/i.test(pathname);
  }
  if (method === "POST") return pathname === "/api/outside/call" || pathname.startsWith("/api/hooks/");
  if (method !== "GET") return false;
  return pathname === "/api/info" || pathname === "/api/host/status" || pathname === "/api/mcp/signed-in" || /^\/api\/sessions\/[\w-]+\/work\/framed$/.test(pathname) || pathname.startsWith("/api/local/backdrops/f/");
}

/** The address that lets a browser in: the pass after the #, which a browser keeps to itself. */
export const enterLink = (url: string, key: string, ttlMs?: number) => `${url.replace(/\/+$/, "")}/#k=${mintTicket(key, ttlMs)}`;

/**
 * What a browser without the key is shown instead of Friday. With a pass in its address it trades it for the cookie and goes
 * on to where it was headed; without one it says how to get in. Nothing of the person's is in it.
 */
export function enterPage(): { html: string; headers: Record<string, string> } {
  const script = `const enter = async () => {
  const m = /^#k=([\\w.-]{20,200})$/.exec(location.hash);
  const show = (wait) => { document.getElementById("wait").hidden = !wait; document.getElementById("how").hidden = wait; };
  if (!m) return show(false);
  show(true);
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const r = await fetch("/api/local/enter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: m[1] }) });
    if (r.ok) return location.replace(location.pathname + location.search);
  } catch {}
  show(false);
};
// The link pasted into a tab already showing this page changes only what is after the #: read then too.
addEventListener("hashchange", enter);
enter();`;
  const nonce = randomBytes(12).toString("base64url");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Friday</title>
<style nonce="${nonce}">
  html { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: #fafaf9; color: #1c1c1c; }
  main { max-width: 30rem; padding: 2rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
  p { margin: 0 0 0.75rem; }
  code { font: 13px ui-monospace, monospace; padding: 0.1rem 0.3rem; border-radius: 4px; background: rgba(127, 127, 127, 0.18); }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1c; color: #f2f2f0; } }
</style>
</head>
<body>
<main>
  <p id="wait">Opening Friday…</p>
  <div id="how" hidden>
    <h1>This browser hasn't been let into Friday yet</h1>
    <p>Friday runs on this computer and only opens for you. To use it here, start Friday again from a terminal with the command you used before. It finds the one already running and opens it here, let in.</p>
    <p>If Friday is the desktop app, use its own window.</p>
  </div>
</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  return {
    html,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "referrer-policy": "no-referrer",
    },
  };
}
