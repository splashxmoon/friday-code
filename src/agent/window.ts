/**
 * How much an own model can be sent (Arun, 2026-11-28: "more control over the local models like raising context size...
 * compacting so we can continue"; handoff HANDOFF-local-models-2026-11-28, phase 1).
 *
 * Friday's agent used to replay up to a fixed 320,000 characters of a session to every model, about 80k tokens, whatever its
 * window. A local model on llama.cpp at 32k was sent 36k, refused it, and Try again sent the same 36k. Now:
 *  - each own model's window is learned: asked of its server (llama.cpp, Ollama, LM Studio, runner/own-models.ts ownWindow),
 *    else read out of the overflow error itself, which every server words with the number in it;
 *  - the history is fitted to the window less the instructions, the tools and room for the reply, counted in tokens, with the
 *    characters per token learned from what the server said the last request was (usage.prompt_tokens);
 *  - an overflow is fitted and sent again once, on its own, with what the error said; a second is said plainly (runtime.ts).
 */

/** Characters per token until a server says otherwise: a little under what English prose averages, so the estimate errs safe. */
export const CHARS_PER_TOKEN = 3.2;
/** Kept free in every request for the reply, unless the person picks another (Settings › Your models, phase 3). */
export const REPLY_ROOM = 4096;
/** Never fitted to less than this much history, in characters: a window too small for any of it is said, not sent empty. */
const MIN_HISTORY = 2_000;

/**
 * A model's window, out of the error its server sent when a request didn't fit: llama.cpp, OpenAI and the many servers worded
 * like it, vLLM, Ollama, LM Studio. Also how many tokens the request was, when it says. Null when it isn't an overflow.
 */
export function overflowOf(message: string): { window: number | null; asked: number | null } | null {
  const m = message.replace(/,(?=\d{3}\b)/g, "");
  const num = (re: RegExp) => {
    const x = re.exec(m);
    return x ? Number(x[1]) : null;
  };
  // llama.cpp: "request (36664 tokens) exceeds the available context size (32768 tokens), try increasing it"
  if (/exceeds the available context size/i.test(m)) return { window: num(/available context size \((\d+) tokens?\)/i), asked: num(/request \((\d+) tokens?\)/i) };
  // OpenAI and alike: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."
  // vLLM: "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (…)".
  if (/maximum context length is \d+/i.test(m) || /context_length_exceeded/i.test(m))
    return { window: num(/maximum context length is (\d+)/i), asked: num(/resulted in (\d+) tokens/i) ?? num(/requested (\d+) tokens/i) ?? num(/(\d+) tokens? \(\d+ in the messages/i) };
  // LM Studio: "Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 8192 tokens"
  if (/context length of only \d+/i.test(m)) return { window: num(/context length of only (\d+)/i), asked: num(/keep the first (\d+) tokens/i) };
  // Ollama and others that only say it: "the input length exceeds the context length", "prompt is too long", "context window exceeded".
  if (/input length exceeds the context length|context (?:window|length) (?:was )?exceeded|prompt (?:is )?too long|too many tokens|exceeds the context window/i.test(m))
    return { window: num(/context (?:length|window|size) (?:of |is )?(\d{3,7})/i), asked: num(/(\d{3,7}) tokens/i) };
  return null;
}

/** What the person set for a model (Settings › Your models, phase 3): what happens when it fills, the reply's room, who summarises. */
export interface WindowPrefs {
  whenFull: "compact" | "ask" | "drop";
  reply: number;
  /** An own model's id to write summaries with; "" is the same model. */
  summarizer: string;
}
/** Until the person picks (HANDOFF decision 1, the suggested default): compact at 75%, 4k for the reply, the same model. */
export const DEFAULT_PREFS: WindowPrefs = { whenFull: "compact", reply: REPLY_ROOM, summarizer: "" };
/** What a model's server and settings say: its window, when known, and the person's choices. */
export type WindowAnswer = { window: number | null } & Partial<WindowPrefs>;

/** What Friday knows of one model: its window, and how many characters make one of its tokens. */
interface Known {
  window: number | null;
  ratio: number;
  /** Where the window came from: its server, or an overflow error (believed over the server, which may have reloaded). */
  from: "server" | "error" | null;
  at: number;
  prefs: WindowPrefs;
}

/** A model asked again for its window after this long: the person may have reloaded it bigger (phase 3, Apply and reload). */
const ASK_AGAIN_MS = 5 * 60_000;

/**
 * Each own model's window and token ratio, kept per model id for as long as Friday runs. `ask` is its server, through the
 * computer that runs it; it may answer null (a hosted key, an older runner, a server that doesn't say).
 */
export class WindowBook {
  private known = new Map<string, Known>();
  private asking = new Map<string, Promise<WindowAnswer | null>>();
  constructor(private ask: (model: string) => Promise<WindowAnswer | null>) {}

  private of(model: string): Known {
    let k = this.known.get(model);
    if (!k) this.known.set(model, (k = { window: null, ratio: CHARS_PER_TOKEN, from: null, at: 0, prefs: { ...DEFAULT_PREFS } }));
    return k;
  }

  /** Its window, asked of its server the first time, again after a while, and again once a request overflowed. */
  async window(model: string): Promise<number | null> {
    const k = this.of(model);
    if (k.at && Date.now() - k.at < ASK_AGAIN_MS) return k.window;
    let p = this.asking.get(model);
    if (!p) {
      p = this.ask(model).catch(() => null);
      this.asking.set(model, p);
    }
    const got = await p;
    this.asking.delete(model);
    if (got?.window && got.window > 0) Object.assign(k, { window: got.window, from: "server" });
    if (got) k.prefs = { whenFull: got.whenFull ?? k.prefs.whenFull, reply: got.reply ?? k.prefs.reply, summarizer: got.summarizer ?? k.prefs.summarizer };
    k.at = Date.now();
    return k.window;
  }

  /** What the person set for it, as of the last time it was asked (window() asks). */
  async prefs(model: string): Promise<WindowPrefs> {
    await this.window(model);
    return this.of(model).prefs;
  }

  /** Settings changed: asked again on the next step. */
  forget(model?: string): void {
    if (model) this.known.delete(model);
    else this.known.clear();
  }

  /** What an overflow said: its window (believed at once), and the tokens a request of `chars` characters came to. */
  overflowed(model: string, o: { window: number | null; asked: number | null }, chars: number): void {
    const k = this.of(model);
    if (o.window) Object.assign(k, { window: o.window, from: "error" });
    if (o.asked && chars > 0) k.ratio = clampRatio(chars / o.asked);
    // Asked again on the next turn: the server's own figure is the one to keep once it's back to answering.
    k.at = o.window ? Date.now() : 0;
  }

  /** What the server counted a request of `chars` characters as: the ratio from now on, eased so one odd request can't swing it. */
  counted(model: string, chars: number, promptTokens: number | undefined): void {
    if (!promptTokens || promptTokens < 50 || chars < 200) return;
    const k = this.of(model);
    k.ratio = clampRatio(k.ratio * 0.5 + (chars / promptTokens) * 0.5);
  }

  ratio(model: string): number {
    return this.of(model).ratio;
  }

  /** Tokens, from characters, as this model counts them. */
  tokens(model: string, chars: number): number {
    return Math.ceil(chars / this.of(model).ratio);
  }

  /**
   * How many characters of history fit: the window, less room for the reply, less the instructions and the tools, as this model
   * counts them; null when its window isn't known (the old fixed ceiling stays). `tighter` takes a further share off, for the one
   * retry after an overflow, so an estimate that was off still lands inside.
   */
  budget(model: string, window: number | null, fixedChars: number, reply = REPLY_ROOM, tighter = 1): number | null {
    if (!window) return null;
    const ratio = this.of(model).ratio;
    const room = Math.floor((window - reply) * ratio * tighter) - fixedChars;
    return Math.max(MIN_HISTORY, room);
  }
}

const clampRatio = (r: number) => Math.min(6, Math.max(1.5, r));

/** The characters a request's instructions and tools take, as they go on the wire. */
export const fixedChars = (system: string, tools: unknown[]) => system.length + (tools.length ? JSON.stringify(tools).length : 0);

/** The characters of a conversation as it goes on the wire: what the server counts as its tokens. */
export const messageChars = (messages: { content?: unknown; tool_calls?: unknown }[]) =>
  messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 12, 0);

/**
 * What the thread says when a step still didn't fit after it was fitted and sent again (card 1C in the mock): how big it was and
 * how big the window is, never the server's raw text. The page knows it by its first words ("Out of room:", Activity.tsx).
 */
export function roomError(o: { window: number | null; asked: number | null }, window: number | null, estimate: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const w = o.window ?? window;
  const asked = o.asked ?? estimate;
  return `Out of room: ${n(asked)} tokens asked, and its window is ${w ? n(w) : "smaller"}. Friday fitted it and tried once more; what's left is too big for this window. Raise its window in Settings, Your models, or shorten the output that filled it.`;
}
