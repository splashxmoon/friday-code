import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import os from "node:os";
import { parseComputerLink } from "./join.js";

/**
 * Linking your computers in two clicks (Arun, 2026-11-21: "make it way easier to link up machines too"). Before this, adding one
 * meant copying a link or a command from one computer to the other. Now each Friday on the same network can be found from the
 * other: Add a computer lists the ones nearby, Link sends that one an offer, and it asks its person "Allow?", showing a six-digit
 * check number both screens show. Yes, and it pairs with the offer's link exactly as a pasted one does (join.ts): the same
 * one-time code, the same pinned certificate. Nothing here can link anything by itself.
 *
 * On the wire: small JSON over UDP on one port (4391), on the local network only.
 * - "who": broadcast by a Friday looking; every Friday whose page is open answers "here" to the sender with its name and system,
 *   and whether it is already used from the one asking (a hash only the asker can match, so the list can say "Linked").
 * - "offer": sent to one Friday, by id: who it's from, where to pair (the link without its code) and a proof made from the code.
 *   It is kept for that link's ten minutes until its person answers. A Friday that isn't named ignores it.
 *
 * Anyone on the network can send an offer, under any name (security audit 2026-11-27, server H1: a six-digit number taken
 * from the offered certificate could be matched by making certificates until one fit, so a forged offer showed the expected
 * name and number, and Allow handed this computer to the forger). So an offer is only as good as the pairing code, which is
 * shown on the computer that started it and nowhere on the wire: the person types it here, and this computer links only to an
 * offer whose proof was made with that code and that offer's certificate. Someone who never saw the code can't make one, and a
 * prompt nobody started has no code to type. The same code then pairs this computer there (join.ts), so each side has checked
 * the other.
 *
 * And it listens only while this computer's page is open (need): a Friday running as a service, or with nobody at it, is found
 * by nobody and takes no offers.
 */

export const NEARBY_PORT = 4391;

export interface NearbyFound {
  id: string;
  name: string;
  platform: string;
  version: string;
  address: string;
  /** The certificate of the Friday it's used from, if it's paired with one. */
  pairedWith: string | null;
}

export interface NearbyOffer {
  /** This offer, to answer it by: not the sender's id, which anyone can claim. */
  from: string;
  /** What the sender calls itself. Anyone can say any name: the code is what tells. */
  name: string;
  until: number;
  /** Where to pair, without the code. */
  link: string;
  address: string;
  /** The id its sender gave, which the proof is made with. */
  sender: string;
  /** Made from the code and this offer's certificate (offerProof). */
  proof: string;
  tries: number;
}

/** Offers kept at once, and from one address; wrong codes before an offer is dropped; how long after a "who" its sender may offer. */
const OFFERS_MAX = 5;
const OFFERS_PER_ADDRESS = 2;
const CODE_TRIES = 5;
const WHO_WINDOW_MS = 2 * 60_000;
/** How long it goes on listening after this computer's page last asked (it asks about once a minute while shown). */
const LISTEN_MS = 3 * 60_000;

/** A pairing code as typed: its letters and digits, whatever the case or spacing. */
export const typedCode = (s: unknown): string => (typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) : "");

/**
 * What proves an offer was made by whoever holds the pairing code, for this certificate and these two computers. Slow on
 * purpose (scrypt): the code is short, and someone who overheard an offer must not be able to try every code against it in
 * the ten minutes the code lasts.
 */
export function offerProof(code: string, fingerprint: string, from: string, to: string): Promise<string> {
  return new Promise((resolve, reject) => scrypt(typedCode(code), `friday-nearby:${fingerprint.toLowerCase()}:${from}:${to}`, 32, { N: 16384, r: 8, p: 1 }, (e, key) => (e ? reject(e) : resolve(key.toString("hex")))));
}

/** A link without its code, and with one put back. */
const CODE_HOLDER = "00000000";
function withCode(link: string, code: string | null): string {
  const at = link.indexOf("?");
  if (at < 0) return link;
  const q = new URLSearchParams(link.slice(at + 1));
  q.delete("c");
  if (code) q.set("c", code);
  return `${link.slice(0, at)}?${q}`;
}

/** Whether this computer is used from the one asking, said so only the asker can tell: a hash of its nonce and that Friday's certificate. */
const pairedTag = (nonce: string, fingerprint: string) => createHash("sha256").update(`friday-nearby-paired:${nonce}:${fingerprint.toLowerCase()}`).digest("hex").slice(0, 32);

/** Each network's broadcast address, and the general one: Wi-Fi drops the general one on some routers. */
function broadcasts(): string[] {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join("."));
    }
  return [...out];
}

export class Nearby {
  private sock: dgram.Socket | null = null;
  private starting: Promise<void> | null = null;
  private lapse: ReturnType<typeof setTimeout> | null = null;
  private offers = new Map<string, NearbyOffer>();
  /** Who asked "who", and when: an offer is only taken from an address this computer has just answered. */
  private asked = new Map<string, number>();
  /** An offer came: this computer's page is told, rather than asking every few seconds (app.ts, spec 13). */
  onChange: (() => void) | null = null;

  constructor(
    private o: {
      id: string;
      name: () => string;
      version: string;
      /** The certificate of the Friday this one is used from, if any. */
      pairedWith: () => Promise<string | null>;
      /** Where it listens; FRIDAY_NEARBY_PORT for two Fridays on one computer (tests). */
      port?: number;
      /** The ports it asks on when it looks: FRIDAY_NEARBY_PORTS, else the one port. */
      ask?: number[];
      log?: (line: string) => void;
    },
  ) {}

  get port() {
    return this.o.port ?? NEARBY_PORT;
  }

  /**
   * This computer's page is open and asking: listen from now until a few minutes after it last asked. Friday listens on the
   * network only while someone is at it to answer an offer, and says nothing about this computer the rest of the time.
   */
  need(): void {
    if (this.lapse) clearTimeout(this.lapse);
    this.lapse = setTimeout(() => this.stop(), LISTEN_MS);
    this.lapse.unref?.();
    if (!this.sock) void (this.starting ??= this.start().finally(() => (this.starting = null)));
  }

  /** Whether it is listening now. */
  get listening(): boolean {
    return !!this.sock;
  }

  /** Listens for "who" and "offer". A port already taken (another Friday here) leaves this one findable by nobody, said once. */
  start(): Promise<void> {
    if (this.sock) return Promise.resolve();
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      s.on("error", (e) => {
        this.o.log?.(`nearby: ${e.message}`);
        s.close();
        this.sock = null;
        resolve();
      });
      s.on("message", (buf, from) => void this.heard(buf, from));
      s.bind(this.port, () => {
        s.setBroadcast(true);
        this.sock = s;
        resolve();
      });
    });
  }

  stop() {
    if (this.lapse) clearTimeout(this.lapse);
    this.lapse = null;
    this.sock?.close();
    this.sock = null;
    this.asked.clear();
  }

  private async heard(buf: Buffer, from: dgram.RemoteInfo) {
    if (buf.length > 4096) return;
    let m: { t?: string; id?: string; to?: string; name?: string; link?: string; proof?: string; n?: string; v?: number };
    try {
      m = JSON.parse(String(buf));
    } catch {
      return;
    }
    if (!m || typeof m !== "object" || m.id === this.o.id) return;
    const now = Date.now();
    if (m.t === "who") {
      for (const [k, at] of this.asked) if (now - at > WHO_WINDOW_MS) this.asked.delete(k);
      if (this.asked.size < 200 || this.asked.has(from.address)) this.asked.set(from.address, now);
      // Its name and system, to be picked from a list; not its Friday's version, and not which computer it is used from: only
      // whether that is the one asking, which the asker alone can read (pairedTag).
      const hub = typeof m.n === "string" && /^[\w-]{8,64}$/.test(m.n) ? await this.o.pairedWith().catch(() => null) : null;
      const here = { t: "here", v: 2, id: this.o.id, name: this.o.name(), platform: process.platform, paired: hub ? pairedTag(m.n!, hub) : null };
      this.sock?.send(JSON.stringify(here), from.port, from.address);
      return;
    }
    if (m.t === "offer" && m.to === this.o.id && typeof m.link === "string" && typeof m.id === "string" && typeof m.proof === "string" && /^[0-9a-f]{64}$/.test(m.proof)) {
      // Only from an address that has just looked for this computer: one that never asked is nobody's Add a computer.
      if (now - (this.asked.get(from.address) ?? 0) > WHO_WINDOW_MS) return;
      const link = withCode(m.link.slice(0, 2000), null);
      // With a certificate to pin (a link without one could be anyone's), and no code in it: the code is typed here.
      if (!parseComputerLink(withCode(link, CODE_HOLDER))?.hub.fingerprint) return;
      for (const [k, v] of this.offers) if (v.until < now) this.offers.delete(k);
      const key = createHash("sha256").update(`${from.address}|${m.id}|${m.proof}`).digest("hex").slice(0, 32);
      // One already waiting is never replaced by a later one, and only so many wait at once: a second offer can't take the
      // place of the one the person is looking at, and offers can't pile up.
      if (this.offers.has(key) || this.offers.size >= OFFERS_MAX) return;
      if ([...this.offers.values()].filter((v) => v.address === from.address).length >= OFFERS_PER_ADDRESS) return;
      const name = String(m.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "A computer";
      this.offers.set(key, { from: key, name, until: now + 10 * 60_000, link, address: from.address, sender: m.id.slice(0, 64), proof: m.proof, tries: 0 });
      this.o.log?.(`nearby: ${name} offered to link from ${from.address}`);
      this.onChange?.();
    }
  }

  /**
   * The Fridays on this network that answer within `ms`. `mine`: this Friday's own certificate, to tell which of them are
   * already used from it (their `pairedWith` is then `mine`; "another" when it is some other computer's).
   */
  find(ms = 1200, mine: string | null = null): Promise<NearbyFound[]> {
    return new Promise((resolve) => {
      const s = dgram.createSocket("udp4");
      const found = new Map<string, NearbyFound>();
      const nonce = randomBytes(12).toString("base64url");
      s.on("error", () => (s.close(), resolve([...found.values()])));
      s.on("message", (buf, from) => {
        try {
          const m = JSON.parse(String(buf)) as { t?: string; id?: string; name?: unknown; platform?: unknown; paired?: unknown };
          if (m.t !== "here" || typeof m.id !== "string" || !/^[0-9a-f]{8,64}$/.test(m.id) || m.id === this.o.id) return;
          const paired = typeof m.paired === "string" && m.paired ? (mine && m.paired === pairedTag(nonce, mine) ? mine : "another") : null;
          if (found.size < 50 || found.has(m.id)) found.set(m.id, { id: m.id, name: String(m.name ?? "A computer").replace(/\s+/g, " ").slice(0, 60), platform: String(m.platform ?? "").slice(0, 20), version: "", address: from.address, pairedWith: paired });
        } catch {}
      });
      s.bind(0, () => {
        s.setBroadcast(true);
        const msg = JSON.stringify({ t: "who", v: 2, id: this.o.id, n: nonce });
        for (const port of this.o.ask ?? [this.port]) for (const to of broadcasts()) s.send(msg, port, to);
        setTimeout(() => (s.close(), resolve([...found.values()])), ms);
      });
    });
  }

  /**
   * Sends one Friday found nearby an offer to link: where to pair (this computer's pairing link, without its code) and a proof
   * made from the code. The code itself is never sent: this computer's page shows it, to be typed there.
   */
  async offer(to: NearbyFound, link: string): Promise<void> {
    const parsed = parseComputerLink(link);
    if (!parsed?.hub.fingerprint) throw new Error("Nearby linking needs this computer's own certificate.");
    const proof = await offerProof(parsed.code, parsed.hub.fingerprint, this.o.id, to.id);
    const s = dgram.createSocket("udp4");
    const msg = JSON.stringify({ t: "offer", v: 2, id: this.o.id, to: to.id, name: this.o.name(), link: withCode(link, null), proof });
    await new Promise<void>((resolve) => s.bind(0, () => resolve()));
    for (const port of new Set([this.port, ...(this.o.ask ?? [])])) await new Promise<void>((resolve) => s.send(msg, port, to.address, () => resolve()));
    s.close();
  }

  /** Offers waiting for this computer's person, oldest first: the one they are looking at stays the one shown. */
  pending(): Pick<NearbyOffer, "from" | "name" | "until">[] {
    const now = Date.now();
    for (const [k, v] of this.offers) if (v.until < now) this.offers.delete(k);
    return [...this.offers.values()].map(({ from, name, until }) => ({ from, name, until }));
  }

  /** An offer turned down: dropped. */
  drop(from: string): boolean {
    return this.offers.delete(from);
  }

  /**
   * The code typed for an offer. The offer it proves (the one answered, or another waiting: a forged prompt must not stand in
   * the real one's way) is taken, with the code in its link, to pair with. "wrong" when it proves none, counted against the one
   * answered, which is dropped after a few; null when that offer has run out.
   */
  async accept(from: string, typed: unknown): Promise<NearbyOffer | "wrong" | null> {
    const now = Date.now();
    const named = this.offers.get(from);
    if (!named || named.until < now) return (this.offers.delete(from), null);
    const code = typedCode(typed);
    if (code.length >= 6) {
      for (const o of [named, ...[...this.offers.values()].filter((x) => x !== named && x.until >= now)]) {
        const fingerprint = parseComputerLink(withCode(o.link, CODE_HOLDER))?.hub.fingerprint;
        if (!fingerprint) continue;
        const want = Buffer.from(o.proof, "hex");
        const got = Buffer.from(await offerProof(code, fingerprint, o.sender, this.o.id), "hex");
        if (got.length === want.length && timingSafeEqual(got, want)) {
          this.offers.delete(o.from);
          return { ...o, link: withCode(o.link, code) };
        }
      }
    }
    if (++named.tries >= CODE_TRIES) this.offers.delete(from);
    return "wrong";
  }
}
