// Reaching your computer from anywhere (reach-relay.ts, local/reach.ts, local/phone.ts): a phone away from the computer's network
// gets in through the relay with the same pinned TLS as on Wi-Fi, the relay passes only ciphertext, and everything the listener
// decides (tokens, removal, phone access off) holds through it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import tls from "node:tls";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, createWebSocketStream } from "ws";
import { PhoneAccess, type PhoneKV } from "../src/local/phone.js";
import { PushRelay, relayServer } from "../src/push-relay.js";
import { statSync } from "node:fs";
import { CLAIM_TTL_SEC, CLOSE, ReachRelay, fileClaims } from "../src/reach-relay.js";

function memKV(): PhoneKV {
  const s = new Map<string, string>();
  const h = new Map<string, Map<string, string>>();
  const hm = (k: string) => (h.get(k) ?? (h.set(k, new Map()), h.get(k)!));
  return {
    get: async (k) => s.get(k) ?? null,
    set: async (k, v) => void s.set(k, v),
    del: async (k) => void s.delete(k),
    hget: async (k, f) => hm(k).get(f) ?? null,
    hset: async (k, f, v) => void hm(k).set(f, v),
    hdel: async (k, f) => void hm(k).delete(f),
    hgetall: async (k) => Object.fromEntries(hm(k)),
  };
}

const until = async (ok: () => Promise<boolean> | boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

/** One HTTP request as the phone makes it, over TLS through the relay: the bytes the relay sees are kept to look at. */
async function viaRelay(base: string, id: string, fingerprint: string, request: string): Promise<{ status: number; body: string; seen: Buffer } | { closed: number }> {
  const ws = new WebSocket(`${base}/reach/${id}`);
  const seen: Buffer[] = [];
  ws.on("message", (d) => seen.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)));
  const origSend = ws.send.bind(ws);
  ws.send = ((d: Buffer, ...rest: unknown[]) => {
    seen.push(Buffer.from(d));
    if (ws.readyState === WebSocket.OPEN) origSend(d, ...(rest as []));
    else (rest.find((x) => typeof x === "function") as ((e?: Error) => void) | undefined)?.();
  }) as typeof ws.send;
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const opened = await Promise.race([new Promise<boolean>((r) => ws.on("open", () => r(true))), closed.then(() => false)]);
  if (!opened) return { closed: await closed };
  const raw = createWebSocketStream(ws);
  const sock = tls.connect({ socket: raw, rejectUnauthorized: false });
  sock.on("error", () => {});
  const early = await Promise.race([new Promise<number>((r) => sock.on("secureConnect", () => r(0))), closed]);
  if (early) return { closed: early };
  // The certificate the phone pinned as it paired: anyone else's is refused.
  assert.equal(sock.getPeerX509Certificate()!.fingerprint256.replace(/:/g, "").toLowerCase(), fingerprint);
  sock.write(request);
  const text = await new Promise<string>((resolve) => {
    let b = "";
    sock.on("data", (c) => {
      b += c;
      if (/\r\n\r\n[\s\S]*\}$/.test(b) || /Content-Length: 0/.test(b)) resolve(b);
    });
    sock.on("close", () => resolve(b));
    // The listener closes the connection after answering (HTTP/1.0); through the relay that arrives as the stream closing.
    ws.on("close", () => setTimeout(() => resolve(b), 20));
    setTimeout(() => resolve(b), 4_000);
  });
  sock.destroy();
  ws.terminate();
  return { status: Number(/^HTTP\/1\.[01] (\d+)/.exec(text)?.[1] ?? 0), body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n"), seen: Buffer.concat(seen) };
}

const get = (p: string, token: string) => `GET ${p} HTTP/1.0\r\nHost: friday\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`;

test("a phone away from home reaches the computer through the relay, which sees only ciphertext; removal and phone access off hold through it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "reach-"));
  const app = http.createServer((req, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ path: req.url }))));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const reach = new ReachRelay();
  const relay = relayServer(new PushRelay(null), { reach });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const base = `ws://127.0.0.1:${(relay.address() as { port: number }).port}/api/relay`;
  const phone = new PhoneAccess({ kv: memKV(), home, appPort: (app.address() as { port: number }).port, computer: "Test Mac", addresses: () => [{ address: "127.0.0.1", via: "tailscale" }], relay: base });
  t.after(async () => {
    await phone.stop();
    reach.close();
    relay.close();
    app.close();
    await rm(home, { recursive: true, force: true });
  });

  await phone.setOn(true);
  const st = await phone.setReach(true);
  assert.equal(st.reach?.on, true);
  await until(async () => (await phone.state()).reach?.connected === true);
  // The pairing code carries the relay route (only with a certificate; the test machine may have no openssl).
  const code = (await phone.pairCode()) as { code: string; link: string };
  const link = new URL(code.link);
  if (link.searchParams.get("s") !== "https") return t.skip("no openssl here: the relay never carries plain HTTP");
  const id = link.searchParams.get("r")!;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(link.searchParams.get("rb"), base);
  const fp = link.searchParams.get("f")!;

  // Paired through the relay, as a phone away from home does with the code it scanned.
  const pairBody = JSON.stringify({ code: code.code, name: "Maya's iPhone" });
  const paired = await viaRelay(base, id, fp, `POST /phone/pair HTTP/1.0\r\nHost: friday\r\nContent-Type: application/json\r\nContent-Length: ${pairBody.length}\r\nConnection: close\r\n\r\n${pairBody}`);
  assert.ok("status" in paired && paired.status === 200, JSON.stringify(paired));
  const { token, device } = JSON.parse((paired as { body: string }).body) as { token: string; device: string };

  const hello = await viaRelay(base, id, fp, get("/phone/hello", token));
  assert.ok("status" in hello);
  assert.equal(hello.status, 200);
  assert.deepEqual((JSON.parse(hello.body) as { relay: unknown }).relay, { id, relay: base });
  // What passed through the relay: no token, no path, no answer. Only ciphertext.
  for (const plain of [token, "/phone/hello", "Test Mac", "Bearer"]) assert.ok(!hello.seen.includes(Buffer.from(plain)), `the relay saw ${plain}`);

  const passed = await viaRelay(base, id, fp, get("/api/sessions/mine", token));
  assert.ok("status" in passed && passed.status === 200 && passed.body.includes("/api/sessions/mine"));

  // Removed in Settings: refused through the relay as on Wi-Fi.
  await phone.forget(device);
  const gone = await viaRelay(base, id, fp, get("/phone/hello", token));
  assert.ok("status" in gone && gone.status === 401);

  // Phone access off: the relay link closes, and the computer can't be reached at all.
  await phone.setOn(false);
  await until(() => reach.linked === 0);
  const off = await viaRelay(base, id, fp, get("/phone/hello", token));
  assert.deepEqual(off, { closed: CLOSE.offline });
});

test("an id is held by the secret that first claimed it; tries to reach are limited per address", async (t) => {
  const reach = new ReachRelay({ limits: { reachesPerMinute: 3 } });
  const server = relayServer(new PushRelay(null), { reach });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => (reach.close(), server.close()));
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/relay`;
  const id = "a".repeat(32);
  const link = (secret: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/home?id=${id}`, { headers: { "x-friday-secret": secret } });
      ws.on("open", () => (ws.close(), resolve(200)));
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
  assert.equal(await link("s".repeat(40)), 200, "first claims it");
  assert.equal(await link("t".repeat(40)), 401, "another secret can't take it");
  assert.equal(await link("s".repeat(40)), 200, "the same computer comes back");
  assert.equal(await link("short"), 401);
  const tryReach = () =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/reach/${"b".repeat(32)}`);
      ws.on("close", (code) => resolve(code));
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
  assert.equal(await tryReach(), CLOSE.offline, "nobody home");
  await tryReach();
  await tryReach();
  assert.equal(await tryReach(), 429, "three a minute here");
});

// 2026-11-27 security review (M2, L8): what one address can take from the relay, and what a restart forgets.
test("ids can't be claimed in a loop: so many an hour from one address, kept for ninety days past the last link, with room for so many computers", async (t) => {
  const kept: { id: string; ttl: number }[] = [];
  const touched: { id: string; ttl: number }[] = [];
  const m = new Map<string, string>();
  const reach = new ReachRelay({
    limits: { claimsPerHour: 2, homes: 2 },
    claims: { get: async (id) => m.get(id) ?? null, set: async (id, h, ttl) => void (m.set(id, h), kept.push({ id, ttl })), touch: async (id, ttl) => void touched.push({ id, ttl }) },
  });
  const server = relayServer(new PushRelay(null), { reach });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => (reach.close(), server.close()));
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/relay`;
  const open: WebSocket[] = [];
  t.after(() => open.forEach((w) => w.terminate()));
  const link = (id: string, secret = "s".repeat(40)) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/home?id=${id}`, { headers: { "x-friday-secret": secret } });
      open.push(ws);
      ws.on("open", () => resolve(200));
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(32)) as [string, string, string];
  assert.equal(await link(a), 200);
  assert.equal(await link(b), 200);
  assert.equal(await link(c), 429, "a third id from this address within the hour is refused");
  assert.equal(m.has(c), false, "and nothing was kept for it");
  assert.deepEqual(kept.map((k) => k.ttl), [CLAIM_TTL_SEC, CLAIM_TTL_SEC], "a claim is kept for a while, not for ever");
  // A computer that already holds its id is not a new claim: it links again, and its claim is kept longer.
  assert.equal(await link(a), 200);
  assert.deepEqual(touched, [{ id: a, ttl: CLAIM_TTL_SEC }]);
  assert.equal(await link(a, "t".repeat(40)), 401, "still only by its own secret");
  // Room for two computers here: an id claimed earlier (by a computer now away) waits its turn rather than being a third socket.
  m.set(c, m.get(a)!);
  assert.equal(reach.linked, 2);
  assert.equal(await link(c), 429);
});

test("phones still waiting for the computer count toward its streams", async (t) => {
  const reach = new ReachRelay({ limits: { streams: 2, openMs: 5_000 } });
  const server = relayServer(new PushRelay(null), { reach });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => (reach.close(), server.close()));
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/relay`;
  const id = "d".repeat(32);
  // A computer that is linked and never opens the streams it is asked for.
  const home = new WebSocket(`${base}/home?id=${id}`, { headers: { "x-friday-secret": "s".repeat(40) } });
  let asked = 0;
  home.on("message", () => asked++);
  await new Promise((r) => home.on("open", r));
  const phones: WebSocket[] = [];
  t.after(() => [home, ...phones].forEach((w) => w.terminate()));
  const phone = () =>
    new Promise<number | "waiting">((resolve) => {
      const ws = new WebSocket(`${base}/reach/${id}`);
      phones.push(ws);
      ws.on("open", () => setTimeout(() => resolve("waiting"), 300));
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => {});
    });
  assert.equal(await phone(), "waiting");
  assert.equal(await phone(), "waiting");
  assert.equal(await phone(), CLOSE.busy, "a third is told the computer is busy, not held");
  assert.equal(asked, 2, "and the computer was never asked for it");
});

test("behind a proxy the limits count against the proxy's own entry, not one the sender wrote", async (t) => {
  const reach = new ReachRelay({ limits: { reachesPerMinute: 1 } });
  const server = relayServer(new PushRelay(null), { reach, trustProxy: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => (reach.close(), server.close()));
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/relay`;
  const tryReach = (forwarded: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${base}/reach/${"e".repeat(32)}`, { headers: { "x-forwarded-for": forwarded } });
      ws.on("close", (code) => resolve(code));
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
  // As a proxy that appends would send them: what the sender wrote first, then the address the proxy saw.
  assert.equal(await tryReach("1.1.1.1, 203.0.113.9"), CLOSE.offline);
  assert.equal(await tryReach("2.2.2.2, 203.0.113.9"), 429, "a new first entry is not a new sender");
  assert.equal(await tryReach("2.2.2.2, 203.0.113.10"), CLOSE.offline, "another address the proxy saw is");
});

test("a relay somebody runs themselves keeps its claims across a restart, in a file only its user reads", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-claims-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "relay", "claims.json");
  const first = fileClaims(file);
  await first.set("a".repeat(32), "hash-a", 3600);
  await first.set("b".repeat(32), "hash-b", -1);
  await new Promise((r) => setTimeout(r, 1300));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  // The relay started again: the id is still that computer's, so nobody else's secret can claim it first.
  const again = fileClaims(file);
  assert.equal(await again.get("a".repeat(32)), "hash-a");
  assert.equal(await again.get("b".repeat(32)), null, "one not linked with for its whole time is forgotten");
  const reach = new ReachRelay({ claims: again });
  t.after(() => reach.close());
  assert.equal(await (reach as unknown as { owns(id: string, secret: string, from: string): Promise<boolean | "limited"> }).owns("a".repeat(32), "x".repeat(40), "1.2.3.4"), false);
});
