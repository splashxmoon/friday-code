import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { parseComputerLink } from "../src/local/join.js";
import { Nearby, offerProof, typedCode } from "../src/local/nearby.js";

const FP = "c38d7ba5c746ae731600a41ef637316756ff17587f4fe6934c94fd5c75bb559f";
const CODE = "7WYNQBCA";
const LINK = `friday://computer?h=127.0.0.1&p=55214&c=${CODE}&s=https&n=Maya%E2%80%99s+MacBook+Pro&f=${FP}`;
const A = "a".repeat(32);
const B = "b".repeat(32);

/**
 * Nearby link offers (src/local/nearby.ts; security audit 2026-11-27, server H1 and L5). An offer used to be Allowed against a
 * six-digit number taken from the offered certificate, which anyone could match, under any name, and a second offer replaced
 * the first. Now the person types the pairing code shown on the computer that started it, and only an offer made with that
 * code links.
 */

let next = 47300 + (process.pid % 500);
const port = () => next++;
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
/** A raw message to a Friday's nearby port, as anything on the network can send one. Returns what came back, if anything did. */
function send(to: number, msg: unknown, wait = 250): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    let got: Record<string, unknown> | null = null;
    s.on("message", (b) => (got = JSON.parse(String(b)) as Record<string, unknown>));
    s.bind(0, "127.0.0.1", () => s.send(JSON.stringify(msg), to, "127.0.0.1", () => setTimeout(() => (s.close(), resolve(got)), wait)));
  });
}
const pair = async (t: { after(f: () => void): void }, o: { paired?: string | null } = {}) => {
  const ports = [port(), port()];
  const a = new Nearby({ id: A, name: () => "Maya's MacBook Pro", version: "0.4.0", pairedWith: async () => null, port: ports[0]!, ask: ports });
  const b = new Nearby({ id: B, name: () => "Mac mini", version: "0.4.0", pairedWith: async () => o.paired ?? null, port: ports[1]!, ask: ports });
  await a.start();
  await b.start();
  t.after(() => (a.stop(), b.stop()));
  return { a, b, ports };
};
const mini = (address = "127.0.0.1") => ({ id: B, name: "Mac mini", platform: "darwin", version: "", address, pairedWith: null });

test("a code is read as typed, whatever its case or spacing", () => {
  assert.equal(typedCode(" 7wyn-qbca "), CODE);
  assert.equal(typedCode(undefined), "");
});

test("an offer links only with the code shown on the computer that sent it, and the code is never sent", async (t) => {
  const { a, b, ports } = await pair(t);
  // What goes over the network, seen as b's port sees it.
  const seen: string[] = [];
  const tap = (b as unknown as { heard: (buf: Buffer, from: dgram.RemoteInfo) => Promise<void> }).heard.bind(b);
  (b as unknown as { heard: unknown }).heard = (buf: Buffer, from: dgram.RemoteInfo) => (seen.push(String(buf)), tap(buf, from));
  await send(ports[1]!, { t: "who", v: 2, id: A, n: "nonce-nonce-1" });
  await a.offer(mini(), LINK);
  await settle();
  assert.ok(seen.some((m) => m.includes('"offer"')), "the offer arrived");
  assert.ok(!seen.join("\n").includes(CODE), "the code is not on the wire");

  const waiting = b.pending();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.name, "Maya's MacBook Pro");
  assert.ok(!("link" in waiting[0]!) && !("proof" in waiting[0]!), "the page is told who and until when, nothing to pair with");
  assert.equal(a.pending().length, 0, "the offer named b, so a keeps nothing");

  const from = waiting[0]!.from;
  assert.equal(await b.accept(from, "AAAAAAAA"), "wrong", "a code that isn't the sender's");
  assert.equal(await b.accept(from, ""), "wrong", "Allow with nothing typed links nothing");
  assert.equal(b.pending().length, 1, "and the offer still waits for the right one");
  const got = await b.accept(from, "7wyn qbca");
  assert.ok(got && got !== "wrong");
  assert.equal(parseComputerLink(got.link)?.code, CODE, "the link to pair with carries the code typed");
  assert.equal(parseComputerLink(got.link)?.hub.fingerprint, FP);
  assert.equal(await b.accept(from, CODE), null, "taken once");
});

test("a forged offer under a familiar name, with a certificate of the forger's, can't be allowed", async (t) => {
  const { a, b, ports } = await pair(t);
  await send(ports[1]!, { t: "who", v: 2, id: "e".repeat(32) });
  // The forger never saw the code: it claims the real computer's id and name, with its own certificate and a proof it made up
  // or made from a guess.
  const theirs = "f".repeat(64);
  const forged = `friday://computer?h=127.0.0.1&p=6666&s=https&n=Maya&f=${theirs}`;
  await send(ports[1]!, { t: "offer", v: 2, id: A, to: B, name: "Maya's MacBook Pro", link: forged, proof: await offerProof("GUESSED1", theirs, A, B) });
  await settle();
  const fake = b.pending();
  assert.equal(fake.length, 1, "it shows, as any offer does");
  // The person, linking for real at that moment, types the real code into the forged prompt.
  await a.offer(mini(), LINK);
  await settle();
  assert.equal(b.pending().length, 2, "the real offer waits beside it: the first is not replaced");
  assert.equal(b.pending()[0]!.from, fake[0]!.from, "and the one shown stays the one shown");
  const got = await b.accept(fake[0]!.from, CODE);
  assert.ok(got && got !== "wrong", "the code picks the offer it proves");
  assert.equal(parseComputerLink(got.link)?.hub.fingerprint, FP, "which is the real computer's, never the forger's");
  // And with no real offer at all, nothing the person types links to the forger.
  for (const guess of [CODE, "GUESSED2", "AAAAAAAA", "BBBBBBBB", "CCCCCCCC"]) assert.notEqual(typeof (await b.accept(fake[0]!.from, guess)), "object");
  assert.equal(b.pending().length, 0, "five wrong codes and the offer is gone");
});

test("the old offer, a link with its code and a number to compare, is no longer taken", async (t) => {
  const { b, ports } = await pair(t);
  await send(ports[1]!, { t: "who", v: 1, id: A });
  await send(ports[1]!, { t: "offer", v: 1, id: A, to: B, name: "Maya's MacBook Pro", link: LINK });
  assert.equal(b.pending().length, 0);
});

test("a second offer never replaces one waiting, offers are capped, and only an address that just looked may offer", async (t) => {
  const { b, ports } = await pair(t);
  const offer = async (n: number, id = A) => send(ports[1]!, { t: "offer", v: 2, id, to: B, name: `Computer ${n}`, link: LINK.replace(`&c=${CODE}`, ""), proof: String(n).padStart(64, "0") }, 60);
  await offer(0);
  assert.equal(b.pending().length, 0, "an offer out of nowhere: this computer answered no 'who' from there");
  await send(ports[1]!, { t: "who", v: 2, id: A });
  await offer(1);
  await offer(1);
  await offer(2);
  assert.deepEqual(b.pending().map((o) => o.name), ["Computer 1", "Computer 2"], "the first stays first, and the same one again adds nothing");
  for (let n = 3; n < 12; n++) await offer(n, n.toString(16).repeat(32));
  assert.equal(b.pending().length, 2, "two from one address at most, however many ids it claims");
  assert.ok(b.drop(b.pending()[0]!.from));
  assert.equal(b.pending().length, 1);
  // An offer naming another computer, one without a certificate to pin, and one with no proof: dropped.
  await send(ports[1]!, { t: "offer", v: 2, id: A, to: "c".repeat(32), name: "x", link: LINK, proof: "9".repeat(64) }, 60);
  await send(ports[1]!, { t: "offer", v: 2, id: A, to: B, name: "x", link: LINK.replace(/&f=[0-9a-f]+/, ""), proof: "8".repeat(64) }, 60);
  await send(ports[1]!, { t: "offer", v: 2, id: A, to: B, name: "x", link: LINK }, 60);
  assert.equal(b.pending().length, 1);
});

test("it listens only while this computer's page is open, and stops by itself", async (t) => {
  const p = port();
  const b = new Nearby({ id: B, name: () => "Mac mini", version: "0.4.0", pairedWith: async () => null, port: p });
  t.after(() => b.stop());
  assert.equal(b.listening, false, "made, it listens to nothing");
  assert.equal(await send(p, { t: "who", v: 2, id: A }), null, "and answers nobody");
  b.need();
  await settle(100);
  assert.equal(b.listening, true, "the page asked: listening");
  assert.equal((await send(p, { t: "who", v: 2, id: A }))?.t, "here");
  b.stop();
  assert.equal(b.listening, false);
  assert.equal(await send(p, { t: "who", v: 2, id: A }), null);
});

test("it stops listening a few minutes after the page last asked", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = new Nearby({ id: B, name: () => "Mac mini", version: "0.4.0", pairedWith: async () => null, port: port() });
  let stopped = 0;
  const stop = b.stop.bind(b);
  b.stop = () => (stopped++, stop());
  b.need();
  t.mock.timers.tick(2 * 60_000);
  b.need();
  t.mock.timers.tick(2 * 60_000);
  assert.equal(stopped, 0, "asked again meanwhile: still on");
  t.mock.timers.tick(61_000);
  assert.equal(stopped, 1);
  // The socket it was opening as the first need() came is closed too, so nothing is left listening.
  t.mock.timers.reset();
  return new Promise<void>((r) => setTimeout(() => (stop(), r()), 100));
});

test("asked who it is, a Friday says its name and system, not its version nor which computer it is used from", async (t) => {
  const { a, b, ports } = await pair(t, { paired: FP });
  const here = (await send(ports[1]!, { t: "who", v: 2, id: A, n: "nonce-nonce-2" }))!;
  assert.deepEqual(Object.keys(here).sort(), ["id", "name", "paired", "platform", "t", "v"]);
  assert.ok(!JSON.stringify(here).includes(FP), "not the certificate of the computer it is used from");
  assert.ok(!JSON.stringify(here).includes("0.4.0"), "nor its Friday's version");
  assert.equal((await send(ports[1]!, { t: "who", v: 1, id: A }))!.paired, null, "asked without a nonce, nothing about that at all");
  // The one it is used from can still tell, for "Linked" in its list; anyone else only that it is used from another.
  const mine = (await a.find(800, FP)).find((f) => f.id === B);
  if (!mine) return t.skip("broadcast doesn't loop back on this machine");
  assert.equal(mine.pairedWith, FP);
  assert.equal((await a.find(800, "0".repeat(64))).find((f) => f.id === B)?.pairedWith, "another");
  assert.equal((await a.find(800)).find((f) => f.id === B)?.pairedWith, "another");
  void b;
});
