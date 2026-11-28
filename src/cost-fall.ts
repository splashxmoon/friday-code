// Where a turn's, a thread's or a crew run's tokens went, for the Cost Waterfall (client/CostWaterfall.tsx; Arun, 2026-11-27,
// approving the mock: "looks good"). Only what the log already records: each turn's `agent.usage` by kind of token and its model
// (spend.ts reads the same), its run's start and end, what asked for it, and the subagents it sent off (sub-tasks.ts). A turn's
// usage, not each model call's: the log has no finer grain, so nothing here is split further than the tools report it.
import { addTokens as add, NO_TOKENS, plainModel, priceFor, tokensTotal, turnTokens, usdOf, type Price, type Tokens } from "./spend-price.js";
import type { SubTask } from "./sub-tasks.js";
import { ENGINE_MODEL_INFO, MAIN_LANE, type SessionEvent } from "./types.js";

export type Engines = Record<string, { tool?: string; model?: string } | undefined>;

export type FallKind = "cacheRead" | "input" | "cacheWrite" | "output" | "reasoning";
export const KIND_WORDS: Record<FallKind, string> = { cacheRead: "Cache read", input: "Fresh input", cacheWrite: "Cache write", output: "Output", reasoning: "Reasoning" };

export interface FallSub {
  key: string;
  /** "Explore · map every caller of charge()": its type and what it was asked. */
  name: string;
  start: number;
  end: number | null;
  state: "running" | "done" | "failed";
}

export interface FallTurn {
  lane: string;
  /** Where it starts in the log (its run.started, or the reply's first event): Go to this turn scrolls there. */
  seq: number;
  /** What it was asked, in a line; "" when nothing asked for it in words (a wake, a carry-on). */
  ask: string;
  start: number;
  end: number | null;
  state: "running" | "done" | "failed";
  /** As its tool reported them; null when it reported none (Cursor, a turn cut off before its usage came). */
  tokens: Tokens | null;
  tool?: string;
  /** The model it ran on, as its tool said it (else the lane's own, else Auto's pick). */
  model?: string;
  /** How full the model's window was after it, and the window, when the tool says. */
  context?: number;
  window?: number;
  /** Tool calls it made, for the line under its split. */
  steps: number;
  subs: FallSub[];
}

export interface FallGroup {
  lane: string;
  turns: FallTurn[];
  tokens: Tokens;
  /** Whether any of its turns reported tokens at all. */
  counted: boolean;
  ms: number;
  tool?: string;
  /** The model most of its tokens ran on. */
  model?: string;
}

const line = (s: string, max = 160) => (s.split("\n").find((l) => l.trim()) ?? "").trim().replace(/^\[(Check-in|Friday)\]\s*/, "").slice(0, max);

/** Everything that went in (fresh, written to the cache, read back from it) and what came out. */
export const inOf = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead;

/**
 * A turn's tokens by kind, its heaviest first: reasoning apart from the rest of the output (it is part of `output` in spend.ts,
 * so the rows still add up to the total), a kind it didn't use left out. With a price, each at its own rate and sorted by it.
 */
export function kindsOf(t: Tokens, price: Price | null, byPrice = false): { kind: FallKind; tokens: number; usd: number | null }[] {
  const rate: Record<FallKind, number> | null = price ? { cacheRead: price.read, input: price.in, cacheWrite: price.write, output: price.out, reasoning: price.out } : null;
  const n: Record<FallKind, number> = { cacheRead: t.cacheRead, input: t.input, cacheWrite: t.cacheWrite, output: t.output - t.reasoning, reasoning: t.reasoning };
  return (Object.keys(n) as FallKind[])
    .filter((k) => n[k] > 0)
    .map((kind) => ({ kind, tokens: n[kind], usd: rate ? (n[kind] * rate[kind]) / 1e6 : null }))
    .sort((a, b) => (byPrice && a.usd !== null && b.usd !== null ? b.usd - a.usd : 0) || b.tokens - a.tokens);
}

/** A turn's price at its model's list price, or null when Friday knows none (never a made-up figure). */
export function turnUsd(t: FallTurn): number | null {
  if (!t.tokens) return null;
  const p = priceFor(t.tool, t.model, t.end ?? t.start);
  return p ? usdOf(t.tokens, p) : null;
}

/** A model as its own menu names it ("Opus 5.5"), else its id made readable ("claude-opus-5-5" -> "Opus 5.5"). */
export function modelWords(model?: string): string {
  if (!model) return "";
  const id = plainModel(model);
  for (const list of Object.values(ENGINE_MODEL_INFO)) {
    const hit = list.find((m) => m.id === id || m.id === model);
    if (hit && hit.id !== "auto") return hit.label;
  }
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d))?/);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return id.replace(/^gpt/, "GPT").replace(/-codex/, " Codex").replace(/-mini/, " Mini");
}

/**
 * The turns of these lanes between two seqs, in order, each with its tokens, model, state and the subagents it sent off. A turn
 * is a lane's run.started to its run.ended; a usage with no run open (a log from before runs were said) starts one of its own.
 * `subs`: the log's subagents (sub-tasks.ts subTasksOf), from whoever opens it, which has them already.
 */
export function turnsOf(events: readonly SessionEvent[], engines: Engines, subs: readonly SubTask[] = [], lanes?: readonly string[], from = 0, to = Infinity, /** Whether a lane's agent is at work now: a turn the log never ended counts as live only then. */ live?: (lane: string) => boolean): FallTurn[] {
  const only = lanes ? new Set(lanes) : null;
  const open = new Map<string, FallTurn & { endSeq?: number }>();
  const all: (FallTurn & { endSeq?: number })[] = [];
  /** The model Auto last picked on each lane: what its next turns ran on when they didn't say (spend.ts does the same). */
  const routed = new Map<string, string>();
  /** When each open turn last heard anything: where a turn the log never ended is taken to have stopped. */
  const heard = new Map<string, number>();
  for (const e of events) {
    if (e.seq < from || e.seq > to) continue;
    const lane = e.lane ?? MAIN_LANE;
    if (only && !only.has(lane)) continue;
    const b = e.body;
    if (b.type === "model.routed") {
      if (!b.shadow && b.model) routed.set(lane, b.model);
    } else if (b.type === "run.started") {
      // A turn still open when the next starts was cut off without its end in the log (a restart): it stopped where it was last
      // heard, never "live" for hundreds of hours (Arun, 2026-11-27, the thread waterfall's "Live" on a finished thread).
      const was = open.get(lane);
      if (was) ((was.end = heard.get(lane) ?? was.start), (was.state = "done"));
      const asked = events.find((x) => x.seq === b.causedBy);
      const t: FallTurn = { lane, seq: e.seq, ask: asked?.body.type === "instruction" ? line(asked.body.text) : "", start: e.ts, end: null, state: "running", tokens: null, steps: 0, subs: [] };
      open.set(lane, t);
      all.push(t);
    } else if (b.type === "run.ended") {
      const t = open.get(lane);
      if (!t) continue;
      t.end = e.ts;
      t.endSeq = e.seq;
      // Cut off by a lost connection is put back to carry on, not a failure of the work.
      t.state = b.outcome === "error" && !b.cut ? "failed" : "done";
      open.delete(lane);
    } else if (b.type === "agent.message") {
      const t = open.get(lane);
      if (t) t.steps += b.toolCalls.length;
    } else if (b.type === "agent.usage") {
      let t = open.get(lane);
      if (!t) {
        t = { lane, seq: e.seq, ask: "", start: e.ts, end: e.ts, state: "done", tokens: null, steps: 0, subs: [], endSeq: e.seq };
        all.push(t);
      }
      t.tokens = add(t.tokens ?? NO_TOKENS, turnTokens(b));
      const tool = b.tool ?? engines[lane]?.tool;
      const set = engines[lane]?.model;
      const model = b.model || (set === "auto" ? routed.get(lane) : set) || undefined;
      if (tool) t.tool = tool;
      if (model) t.model = model;
      if (b.context) [t.context, t.window] = [b.context, b.window];
    }
    // Heard from after it was handled: a turn's own start isn't the turn before it still going.
    if (open.has(lane) && b.type !== "run.started") heard.set(lane, e.ts);
  }
  // Left open at the log's end: live only while its agent is at work, else stopped where it was last heard.
  if (live) for (const [lane, t] of open) if (!live(lane)) ((t.end = heard.get(lane) ?? t.start), (t.state = "done"));
  for (const t of all) if (!t.tool) t.tool = engines[t.lane]?.tool;
  const sent = subs.filter((s) => s.opened && s.agentType !== "command");
  if (sent.length)
    for (const t of all)
      t.subs = sent
        .filter((s) => s.lane === t.lane && s.seq >= t.seq && s.seq <= (t.endSeq ?? Infinity))
        .map((s) => ({ key: s.key, name: s.agentType && s.agentType !== "general-purpose" ? `${s.agentType} · ${s.description}` : s.description, start: s.start, end: s.end ?? null, state: s.status === "running" ? "running" : s.status === "error" ? "failed" : "done" }));
  return all.map(({ endSeq: _, ...t }) => t);
}

/** One reply's turn: the usage on its lane between where its block starts and ends (as the reply's own count reads it). */
export function replyTurn(events: readonly SessionEvent[], engines: Engines, lane: string, from: number, to: number, ask = ""): FallTurn {
  const inRange = events.filter((e) => e.seq >= from && e.seq <= to && (e.lane ?? MAIN_LANE) === lane);
  const started = inRange.find((e) => e.body.type === "run.started");
  // Its block may start after its run.started (a block cut short and carried on): the run it belongs to, from the log before it.
  const head = started ?? [...events].reverse().find((e) => e.seq < from && (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started");
  const turns = turnsOf(events, engines, [], [lane], head?.seq ?? from, to);
  const t = turns.find((x) => x.seq === head?.seq) ?? turns[0] ?? { lane, seq: from, ask, start: inRange[0]?.ts ?? 0, end: inRange.at(-1)?.ts ?? null, state: "done" as const, tokens: null, steps: 0, subs: [] };
  // Only this block's usage: a run carried on over several blocks has its tokens counted on each block's own reply.
  let tokens: Tokens | null = null;
  for (const e of inRange) if (e.body.type === "agent.usage") tokens = add(tokens ?? NO_TOKENS, turnTokens(e.body));
  return { ...t, tokens, ask: t.ask || ask };
}

/** Turns grouped by lane, in the order each first worked, with their totals. */
export function groupsOf(turns: readonly FallTurn[]): FallGroup[] {
  const by = new Map<string, FallGroup>();
  const models = new Map<string, Map<string, number>>();
  for (const t of turns) {
    const g = by.get(t.lane) ?? { lane: t.lane, turns: [], tokens: NO_TOKENS, counted: false, ms: 0, ...(t.tool ? { tool: t.tool } : {}) };
    g.turns.push(t);
    if (t.tokens) (g.tokens = add(g.tokens, t.tokens)), (g.counted = true);
    g.ms += (t.end ?? Date.now()) - t.start;
    if (t.model && t.tokens) {
      const m = models.get(t.lane) ?? new Map<string, number>();
      m.set(t.model, (m.get(t.model) ?? 0) + tokensTotal(t.tokens));
      models.set(t.lane, m);
    }
    by.set(t.lane, g);
  }
  for (const g of by.values()) {
    const top = [...(models.get(g.lane) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.turns.findLast((t) => t.model)?.model;
    if (top) g.model = top;
  }
  return [...by.values()];
}

/** The axis's end: the total rounded up to a figure an axis is read in (15k, 200k, $0.05). */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * mag >= x * (1 - 1e-9)) return step * mag;
  return 10 * mag;
}
