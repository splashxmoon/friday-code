import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { enterLink, hasKey, KEY_HEADER, keyCookie, keylessRoute, localKey, mintTicket, Tickets } from "../src/local/local-key.js";
import { passedHeaders } from "../src/local/phone.js";
import { startLocal } from "../src/local/start.js";
import { dialOptions, keyServer } from "../src/runner/dial.js";

/**
 * This install's key (src/local/local-key.ts; security audit 2026-11-27, server H2 and desktop-runner H2): the open-source
 * edition answered anything on the computer that said it was Friday's own page, so another account or a sandboxed program had
 * its API and its terminal. Now every request and socket carries the key, which only this person's account can read.
 */

/** Whether a socket to `url` opens: the gate is before the upgrade, so one turned away never does. */
const opens = (url: string, headers: Record<string, string> = {}) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 4000 });
    ws.once("open", () => (ws.close(), resolve(true)));
    ws.once("error", () => resolve(false));
  });

test("Friday on this computer answers only what carries this install's key", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-key-"));
  const friday = await startLocal({ home, port: 0 });
  t.after(async () => {
    await friday.close();
    await rm(home, { recursive: true, force: true });
  });
  const port = new URL(friday.url).port;
  const ws = friday.url.replace(/^http/, "ws");
  const key = { [KEY_HEADER]: friday.key };

  assert.ok(friday.key.length >= 32, "a key was made");
  assert.equal((await readFile(path.join(home, "local-key"), "utf8")).trim(), friday.key);
  if (process.platform !== "win32") assert.equal((await stat(path.join(home, "local-key"))).mode & 0o777, 0o600, "kept to this person's account");

  // A program on this computer, saying it is Friday's own page: every route that reads or changes anything.
  const forged = { "x-friday-local": "1", origin: friday.url };
  for (const [method, route] of [
    ["GET", "/api/me"],
    ["GET", "/api/sessions"],
    ["POST", "/api/sessions"],
    ["GET", "/api/teammates"],
    ["POST", "/api/teammates"],
    ["GET", "/api/hosts"],
    ["GET", "/api/computers"],
    ["GET", "/api/runner/tools"],
    ["POST", "/api/runner/preview.stop"],
    ["GET", "/api/local/diagnostics"],
    ["GET", "/api/version"],
    ["PUT", "/api/local/page"],
  ] as const) {
    for (const headers of [{}, forged, { [KEY_HEADER]: "x".repeat(friday.key.length) }, { cookie: `${keyCookie(port)}=wrong` }] as Record<string, string>[]) {
      const r = await fetch(friday.url + route, { method, headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, ...(method === "GET" ? {} : { body: "{}" }) });
      assert.equal(r.status, 401, `${method} ${route} without the key (${JSON.stringify(Object.keys(headers))})`);
      assert.ok(!(await r.text()).includes(friday.key));
    }
  }
  // The terminal is a shell: its socket, the page's, a runner's and a link's are all turned away before they open.
  for (const p of ["/term?machine=here", "/ws", "/runner", "/link"]) {
    assert.equal(await opens(ws + p), false, `${p} without the key`);
    assert.equal(await opens(ws + p, { origin: friday.url }), false, `${p} saying it is Friday's page`);
  }

  // With it, as Friday's own programs send it and as its page does.
  assert.equal((await fetch(`${friday.url}/api/me`, { headers: key })).status, 200, "the header");
  assert.equal((await fetch(`${friday.url}/api/me`, { headers: { cookie: `other=1; ${keyCookie(port)}=${friday.key}` } })).status, 200, "the page's cookie");
  assert.equal(await opens(`${ws}/term?machine=here`, key), true, "the terminal, with the key");
  assert.equal(await opens(`${ws}/term?machine=here`, { cookie: `${keyCookie(port)}=${friday.key}`, origin: friday.url }), true, "the terminal, from Friday's page");

  // Another site's page is refused as before, key or no key: a browser would not send it the cookie, and this is the second wall.
  const cross = await fetch(`${friday.url}/api/me`, { headers: { ...key, origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  assert.equal(await opens(`${ws}/term?machine=here`, { ...key, origin: "https://evil.example" }), false);
  const renamed = await new Promise<number>((resolve, reject) => http.get(`${friday.url}/api/me`, { headers: { ...key, host: "evil.example" } }, (r) => (r.resume(), resolve(r.statusCode ?? 0))).on("error", reject));
  assert.equal(renamed, 403, "a name that resolves here");

  // What needs no key: whether this is Friday (a second start asks), and routes with a credential of their own, still checked.
  assert.equal((await fetch(`${friday.url}/api/info`)).status, 200);
  const outside = await fetch(`${friday.url}/api/outside/call`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
  assert.equal(outside.status, 401, "an outside agent still needs its own token");
  assert.equal((await fetch(`${friday.url}/api/vscode/tasks`, { headers: { "x-friday-vscode": "guess" } })).status, 401, "Code's extension still needs the token it was started with");

  // A browser without it is shown how to get in, and nothing else.
  const page = await fetch(friday.url + "/");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /hasn't been let into Friday/);
  assert.ok(!html.includes(friday.key) && !page.headers.get("set-cookie"), "the page hands nothing over");
  assert.equal((await fetch(`${friday.url}/?session=abc`)).headers.get("set-cookie"), null);

  // A pass (the link the command opens) is traded for the cookie once, from Friday's own page only.
  const enter = (k: string, headers: Record<string, string> = { origin: friday.url }) => fetch(`${friday.url}/api/local/enter`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ k }) });
  assert.equal((await enter("nonsense")).status, 401);
  assert.equal((await enter(mintTicket("another install's key"))).status, 401);
  assert.equal((await enter(mintTicket(friday.key, -1000))).status, 401, "past its time");
  const pass = mintTicket(friday.key);
  assert.equal((await enter(pass, { origin: "https://evil.example" })).status, 403, "another site's page can't spend one");
  const got = await enter(pass);
  assert.equal(got.status, 200);
  const cookie = String(got.headers.get("set-cookie"));
  assert.match(cookie, new RegExp(`^${keyCookie(port)}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(`${friday.url}/api/me`, { headers: { cookie: cookie.split(";")[0]! } })).status, 200, "and the cookie lets the browser in");
  assert.equal((await enter(pass)).status, 401, "a pass works once");
  assert.match(enterLink(friday.url, friday.key), /^http:\/\/127\.0\.0\.1:\d+\/#k=/, "after the #, which a browser never sends");

  // A second start on the same folder hands back the same key, for whoever opens the Friday already running.
  const again = await startLocal({ home, port: 0 });
  assert.equal(again.already, true);
  assert.equal(again.key, friday.key);
});

test("the key is the same after a restart, and made again when its file was cut short", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-key-"));
  try {
    const first = localKey(home);
    assert.equal(localKey(home), first);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "local-key"), "short");
    const next = localKey(home);
    assert.ok(next.length >= 32 && next !== "short");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a key is matched whole, as a header or the cookie for this port only", () => {
  const key = "k".repeat(43);
  const req = (headers: Record<string, string>) => ({ headers });
  assert.ok(hasKey(req({ [KEY_HEADER]: key }), key, 4321));
  assert.ok(hasKey(req({ cookie: `a=b; friday_key_4321=${key}` }), key, 4321));
  assert.ok(!hasKey(req({ cookie: `friday_key_5000=${key}` }), key, 4321), "another Friday's cookie");
  assert.ok(!hasKey(req({ [KEY_HEADER]: key.slice(1) }), key, 4321));
  assert.ok(!hasKey(req({ [KEY_HEADER]: "" }), key, 4321));
  assert.ok(!hasKey(req({ [KEY_HEADER]: "" }), "", 4321), "no key never matches");
  assert.ok(!hasKey(req({}), key, 4321));
});

test("a pass is this install's, in time, and spent by its first use", () => {
  const key = "k".repeat(43);
  const t = new Tickets(key);
  const now = 1_000_000;
  const pass = mintTicket(key, 60_000, now);
  assert.ok(!t.take(pass, now + 61_000), "too old");
  assert.ok(t.take(pass, now + 1000));
  assert.ok(!t.take(pass, now + 2000), "used");
  assert.ok(!t.take(mintTicket("someone else's", 60_000, now), now));
  const [n, , sig] = mintTicket(key, 60_000, now).split(".");
  assert.ok(!t.take(`${n}.${now + 10 * 60_000}.${sig}`, now), "its time can't be pushed out");
  assert.ok(!t.take(undefined, now) && !t.take("", now) && !t.take("a.b", now));
});

test("only routes with a credential of their own, or nothing private, answer without the key", () => {
  const q = (s = "") => new URLSearchParams(s);
  for (const [m, p, s] of [
    ["GET", "/api/info"],
    ["GET", "/api/host/status"],
    ["POST", "/api/outside/call"],
    ["POST", "/api/hooks/automation/local/abcd1234", "key=x"],
    ["GET", "/api/mcp/signed-in", "state=x"],
    ["GET", "/callback", "state=x&code=y"],
    ["GET", "/api/sessions/abc/work/framed", "t=x"],
    ["GET", "/api/local/backdrops/f/abc/index.html"],
    ["GET", "/chunks/app-1a2b.js"],
    ["HEAD", "/manifest.webmanifest"],
  ] as const)
    assert.ok(keylessRoute(m, p, q(s)), `${m} ${p}`);
  for (const [m, p] of [
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/callback"],
    ["GET", "/api/me"],
    ["GET", "/api/sessions/abc/work/frame-token"],
    ["GET", "/api/sessions/abc/files/x.png"],
    ["POST", "/api/sessions"],
    ["POST", "/api/local/backdrops"],
    ["DELETE", "/api/local/backdrops/f/abc/x.png"],
    ["POST", "/chunks/app.js"],
    ["GET", "/api/outside/call"],
    ["GET", "/api/vscode/tasks"],
    ["GET", "/api/runner/file.png"],
  ] as const)
    assert.ok(!keylessRoute(m, p, q()), `${m} ${p}`);
});

test("the phone's listener hands on with the key, and a phone can't send one of its own", () => {
  const h = passedHeaders({ "x-friday-key": "theirs", cookie: "friday_key_4321=theirs", accept: "*/*" }, 4321, undefined, undefined, "ours");
  assert.equal(h["x-friday-key"], "ours");
  assert.equal(h.cookie, undefined);
  assert.equal(passedHeaders({ "x-friday-key": "theirs" }, 4321)["x-friday-key"], undefined);
});

test("the runners Friday starts dial back with the key, as a header and only to this Friday", () => {
  keyServer("http://127.0.0.1:4999", "ours");
  assert.deepEqual(dialOptions("ws://127.0.0.1:4999"), { headers: { "x-friday-key": "ours" } });
  assert.deepEqual(dialOptions("http://127.0.0.1:5000"), {});
  keyServer("http://127.0.0.1:4999", "");
  assert.deepEqual(dialOptions("http://127.0.0.1:4999"), {});
});
