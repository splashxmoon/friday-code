// Tokens by kind and what they come to at a model's list price, for the spend audit (spend.ts) and the Cost Waterfall
// (cost-fall.ts). Apart from spend.ts so the waterfall's chunk doesn't reach what the audit reads by (run-why.ts), which the session
// screen loads inside a bigger chunk: a lazy chunk that imports one module of a bigger chunk splits it (test/client-bundle.test.ts).
import { PRICES } from "./types.js";

export interface Tokens {
  /** Read fresh, not from a cache. */
  input: number;
  /** Written to its cache (dearer than fresh input on Anthropic's models). */
  cacheWrite: number;
  /** Read back from its cache (a tenth of fresh input). */
  cacheRead: number;
  output: number;
  /** Of `output`, what went on reasoning, when the tool says. */
  reasoning: number;
}

/** Dollars per million tokens: fresh input, output, cache read, cache write. */
export interface Price {
  in: number;
  out: number;
  read: number;
  write: number;
}

export const NO_TOKENS: Tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
export const tokensTotal = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
export const addTokens = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });

/**
 * OpenAI's list prices for the models Codex runs, dollars per million (fresh in, out, cached in), Standard tier, short context, as
 * developers.openai.com/api/docs/pricing gives them on 2026-11-28 (Arun, 2026-11-28: "why we are not able to track codex pricing":
 * only GPT-5 and 5.1 were here, so every GPT-6 turn came to no price). Writing to the cache costs nothing extra.
 */
const OPENAI: Record<string, [number, number, number]> = {
  "gpt-6.2-astra": [8, 40, 0.4],
  "gpt-6.2-sol": [2, 10, 0.1],
  "gpt-6.1-sol": [2, 10, 0.1],
  "gpt-6.1-terra": [1, 5, 0.05],
  "gpt-6-astra": [10, 50, 1],
  "gpt-6-sol": [2, 10, 0.2],
  "gpt-6-luna": [0.1, 0.5, 0.01],
  "gpt-5.6-sol": [4, 20, 0.4],
  "gpt-5.6-terra": [2, 12, 0.2],
  "gpt-5.6-luna": [0.2, 1.2, 0.02],
  "gpt-5.5": [5, 30, 0.5],
  "gpt-5.4": [2.5, 15, 0.25],
  "gpt-5.4-mini": [0.75, 4.5, 0.075],
  "gpt-5.4-nano": [0.2, 1.25, 0.02],
  "gpt-5.2": [1.75, 14, 0.175],
  "gpt-5": [1.25, 10, 0.125],
  "gpt-5-codex": [1.25, 10, 0.125],
  "gpt-5.1": [1.25, 10, 0.125],
  "gpt-5.1-codex": [1.25, 10, 0.125],
  "gpt-5-mini": [0.25, 2, 0.025],
  "gpt-5.1-codex-mini": [0.25, 2, 0.025],
  "gpt-5-nano": [0.05, 0.4, 0.005],
};

/**
 * Google's list prices for the Gemini models Gemini CLI (and others) run, dollars per million (in, out, cached in), paid tier, base
 * context, as aistudio.google.com/docs/pricing gives them on 2026-11-28. Carbon and Argon double on 2026-12-01 and the 3.6 and 3.8
 * Flash models on 2027-01-01: GEMINI_LATER holds those, taken by date.
 */
const GEMINI: Record<string, [number, number, number]> = {
  "gemini-4-carbon": [2, 10, 0.1],
  "gemini-4-argon": [2, 10, 0.1],
  "gemini-4-neon": [3, 15, 0.15],
  "gemini-4-hydrogen": [1.5, 7.5, 0.075],
  "gemini-3.8-flash": [0.75, 3.75, 0.075],
  "gemini-3.6-flash": [0.75, 3.75, 0.075],
  "gemini-3.1-pro": [2, 12, 0.2],
  "gemini-3-flash": [0.5, 3, 0.05],
  "gemini-3.5-flash-lite": [0.3, 2.5, 0.03],
  "gemini-3.1-flash-lite": [0.25, 1.5, 0.025],
  "gemini-2.5-pro": [1.25, 10, 0.125],
  "gemini-2.5-flash": [0.3, 2.5, 0.03],
  "gemini-2.5-flash-lite": [0.1, 0.4, 0.01],
};
const GEMINI_LATER: [from: number, models: Record<string, [number, number, number]>][] = [
  [Date.UTC(2026, 11, 1), { "gemini-4-carbon": [4, 20, 0.2], "gemini-4-argon": [4, 20, 0.2] }],
  [Date.UTC(2027, 0, 1), { "gemini-3.8-flash": [1.5, 7.5, 0.15], "gemini-3.6-flash": [1.5, 7.5, 0.15] }],
];

/** A model id as its tool reports it, plain: no date ("-20251101"), no context tag ("[1m]"), no provider ("anthropic/"). */
export const plainModel = (id: string) =>
  id
    .trim()
    .toLowerCase()
    .replace(/^[a-z-]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");

/** The longest key of `table` the id is or starts with ("claude-opus-4-8-thinking" is claude-opus-4-8's). */
function lookup<T>(table: Record<string, T>, id: string): T | null {
  if (table[id]) return table[id]!;
  const key = Object.keys(table)
    .filter((k) => id.startsWith(`${k}-`) || id.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key]! : null;
}

/** The list price of the model a turn ran on, or null when Friday doesn't know one. */
export function priceFor(tool: string | undefined, model: string | undefined, at?: number): Price | null {
  if (!model) return null;
  const id = plainModel(model);
  const claude = lookup(PRICES, id);
  if (claude && (tool === "claude" || id.startsWith("claude") || ["opus", "sonnet", "haiku", "fable"].includes(id))) return { in: claude[0], out: claude[1], read: claude[0] / 10, write: claude[0] * 1.25 };
  const openai = lookup(OPENAI, id);
  if (openai) return { in: openai[0], out: openai[1], read: openai[2], write: openai[0] };
  // "gemini-3.1-pro-preview" is gemini-3.1-pro's; a later price applies from its date.
  const gid = id.replace(/-(preview|exp)(-[\w-]*)?$/, "");
  const later = GEMINI_LATER.filter(([from]) => (at ?? Date.now()) >= from).reduce((acc, [, ms]) => ({ ...acc, ...ms }), {} as Record<string, [number, number, number]>);
  const gemini = lookup({ ...GEMINI, ...later }, gid);
  if (gemini) return { in: gemini[0], out: gemini[1], read: gemini[2], write: gemini[0] };
  return null;
}

/** What tokens cost at a price, each kind at its own rate. */
export const usdOf = (t: Tokens, p: Price) => (t.input * p.in + t.cacheWrite * p.write + t.cacheRead * p.read + t.output * p.out) / 1e6;

/** One turn's tokens from its `agent.usage`: `input` counts what it wrote to its cache, which is taken out here and kept apart. */
export function turnTokens(b: { input: number; cached: number; output: number; cacheWrite?: number; reasoning?: number }): Tokens {
  const write = Math.min(b.cacheWrite ?? 0, b.input);
  return { input: b.input - write, cacheWrite: write, cacheRead: b.cached ?? 0, output: b.output ?? 0, reasoning: Math.min(b.reasoning ?? 0, b.output ?? 0) };
}
