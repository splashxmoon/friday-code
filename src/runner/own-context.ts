import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { ggufInfo, gpuLimit, kvPerToken, presetFile, presetWith, readGguf, sizeOf, windowSizes, WORKING, writePreset, type GgufInfo } from "./model-context.js";
import { isLocalUrl, ownModelById, serverOrigin, setOwnContext, windowOf, type OwnModel } from "./own-models.js";

/**
 * Settings › Your models › Context (HANDOFF-local-models-2026-11-28, phase 3; the mock's section 2): what a local model's window
 * is, what each size would cost in memory on this computer, the person's choices for it, and changing it.
 *
 * Changing the window:
 *  - llama.cpp in router mode: its own `c =` line in the preset file the router was started with, under the model's own section
 *    (the shared [*] default kept), the old file kept as .bak. Then the model is unloaded, so its next load reads the new size.
 *    Friday never restarts a llama-server it didn't start: when the router hasn't picked the change up, it says so and gives the
 *    command. "Show the change" first, always (the handoff's decision 2, as suggested).
 *  - Ollama: its OpenAI-format endpoint takes no window, so the change is shown (OLLAMA_CONTEXT_LENGTH, or a Modelfile's num_ctx).
 *  - LM Studio: loaded again at the new length with its own `lms` command when it's installed; else the command is shown.
 */

export type Fit = "ok" | "tight" | "no";
export interface ContextInfo {
  server: "llamacpp" | "ollama" | "lmstudio" | null;
  /** The window it runs at now, as its server says. */
  window: number | null;
  /** The longest it was trained for. */
  trained: number | null;
  /** The model file: its size, and its quantisation when the name says it. */
  file: { bytes: number; quant?: string } | null;
  /** KV cache bytes per token of window, and whether the model is a hybrid with fewer growing layers (and how many). */
  kv: { perToken: number; fullLayers: number; layers: number } | null;
  /** What the GPU may use here, and all the memory. */
  gpu: number;
  total: number;
  /** Each size offered, what it would take in all, and whether that fits. */
  sizes: { size: number; bytes: number | null; fit: Fit }[];
  /** For llama.cpp in router mode: its preset file and the model's own line there. */
  preset: { path: string; current: number | null } | null;
  prefs: NonNullable<OwnModel["ctx"]>;
  /** Why some of this couldn't be read (a hosted key, a server that doesn't say). */
  note?: string;
}

const getJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(2_500) }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
};
const argOf = (args: unknown, ...names: string[]) => {
  if (!Array.isArray(args)) return undefined;
  for (let i = 0; i < args.length; i++) if (names.includes(String(args[i]))) return String(args[i + 1] ?? "");
  return undefined;
};

/** A model's GGUF facts and file, from where its server says it is. */
async function modelFacts(m: OwnModel, server: string | null): Promise<{ g: GgufInfo | null; bytes: number | null; kType?: string; vType?: string; quant?: string }> {
  const origin = serverOrigin(m);
  if (server === "llamacpp") {
    // Router mode lists each model with the arguments its own llama-server runs with: the file, and the cache types.
    const list = await getJson(`${origin}/v1/models`);
    const entry = ((list?.data as Record<string, unknown>[] | undefined) ?? []).find((x) => x.id === m.model) as { status?: { args?: unknown } } | undefined;
    const args = entry?.status?.args;
    const path = argOf(args, "--model", "-m");
    if (path) {
      const meta = await readGguf(path);
      const quant = /(Q\d_K_[SML]|Q\d_\d|Q\d_K|F16|BF16|IQ\d_\w+)/i.exec(path)?.[1];
      return { g: meta ? ggufInfo(meta) : null, bytes: await sizeOf(path), kType: argOf(args, "--cache-type-k", "-ctk"), vType: argOf(args, "--cache-type-v", "-ctv"), ...(quant ? { quant: quant.toUpperCase() } : {}) };
    }
  }
  if (server === "ollama") {
    // Ollama says the architecture itself; the file's size comes from its list.
    const show = await getJson(`${origin}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.model }) });
    const tags = await getJson(`${origin}/api/tags`);
    const size = ((tags?.models as { name?: string; size?: number }[] | undefined) ?? []).find((x) => x.name === m.model)?.size ?? null;
    const info = (show?.model_info ?? null) as Record<string, unknown> | null;
    const quant = ((show?.details ?? {}) as { quantization_level?: string }).quantization_level;
    return { g: info ? ggufInfo(info) : null, bytes: size, kType: "f16", ...(quant ? { quant } : {}) };
  }
  return { g: null, bytes: null };
}

export async function ownContext(p: { id: string }): Promise<ContextInfo> {
  const m = await ownModelById(p.id);
  if (!m) throw new Error("That model isn't set up on this computer any more.");
  const prefs = m.ctx ?? {};
  const gpu = gpuLimit();
  const total = os.totalmem();
  if (!isLocalUrl(m.baseUrl)) return { server: null, window: null, trained: null, file: null, kv: null, gpu, total, sizes: [], preset: null, prefs, note: "Its window is the provider's: Friday learns it from the provider's answers." };
  const { window, server } = await windowOf(m);
  const facts = await modelFacts(m, server);
  const per = facts.g ? kvPerToken(facts.g, facts.kType, facts.vType) : null;
  const sizes = windowSizes(facts.g?.trained ?? null).map((size) => {
    const bytes = per && facts.bytes ? facts.bytes + per * size + WORKING : null;
    return { size, bytes, fit: (bytes === null ? "ok" : bytes > gpu ? "no" : bytes > gpu * 0.92 ? "tight" : "ok") as Fit };
  });
  let preset: ContextInfo["preset"] = null;
  if (server === "llamacpp") {
    const path = await presetFile();
    if (path) {
      const text = await readFile(path, "utf8").catch(() => null);
      if (text !== null) preset = { path, current: presetWith(text, m.model, 0).before };
    }
  }
  return {
    server: server as ContextInfo["server"],
    window,
    trained: facts.g?.trained ?? null,
    file: facts.bytes ? { bytes: facts.bytes, ...(facts.quant ? { quant: facts.quant } : {}) } : null,
    kv: facts.g && per ? { perToken: per, fullLayers: facts.g.fullLayers, layers: facts.g.layers } : null,
    gpu,
    total,
    sizes,
    preset,
    prefs,
    ...(!server ? { note: "Friday couldn't tell what kind of server this is, so it learns the window when a request doesn't fit." } : {}),
  };
}

const run = (cmd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (e, out, err) => resolve({ ok: !e, out: String(out || err || "") })));

/** What changing the window takes, said before it's done: the file and line, and what has to happen after. */
export interface WindowChange {
  how: "preset" | "lms" | "manual";
  /** The file and its new line, for llama.cpp's preset. */
  file?: string;
  section?: string;
  line?: string;
  before?: number | null;
  /** A command the person runs themselves, when Friday doesn't. */
  command?: string;
  /** In words. */
  says: string;
}

export async function ownContextSave(p: { id: string; prefs?: unknown; window?: unknown; apply?: unknown }): Promise<{ prefs: NonNullable<OwnModel["ctx"]>; change?: WindowChange; applied?: boolean; window?: number | null; says?: string }> {
  const m = await ownModelById(p.id);
  if (!m) throw new Error("That model isn't set up on this computer any more.");
  const raw = (p.prefs && typeof p.prefs === "object" ? p.prefs : {}) as Record<string, unknown>;
  const prefs: NonNullable<OwnModel["ctx"]> = {
    ...(raw.whenFull === "compact" || raw.whenFull === "ask" || raw.whenFull === "drop" ? { whenFull: raw.whenFull } : {}),
    ...(raw.reply === 2048 || raw.reply === 4096 || raw.reply === 8192 ? { reply: raw.reply } : {}),
    ...(typeof raw.summarizer === "string" && /^[\w-]{0,20}$/.test(raw.summarizer) ? { summarizer: raw.summarizer } : {}),
  };
  if (Object.keys(prefs).length) await setOwnContext(p.id, prefs);
  const saved = (await ownModelById(p.id))?.ctx ?? {};
  const size = Number(p.window);
  if (!Number.isInteger(size) || size < 2048 || size > 1_048_576 || !isLocalUrl(m.baseUrl)) return { prefs: saved };
  const { server } = await windowOf(m);
  const change = await changeFor(m, server, size);
  if (p.apply !== true || change.how === "manual") return { prefs: saved, change };
  if (change.how === "preset") {
    const text = await readFile(change.file!, "utf8");
    await writePreset(change.file!, presetWith(text, m.model, size).text);
    // Unloaded, so its next load reads the new line; a router that keeps its presets from start-up needs restarting instead.
    const origin = serverOrigin(m);
    await fetch(`${origin}/models/unload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.model }), signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const now = (await windowOf(m)).window;
    if (now === size) return { prefs: saved, change, applied: true, window: now };
    return { prefs: saved, change, applied: false, window: now, says: `Saved in ${change.file}. llama.cpp reads it when llama-server starts: restart it to use ${size.toLocaleString("en-US")} tokens.` };
  }
  // LM Studio, with its own command.
  await run("lms", ["unload", m.model]);
  const r = await run("lms", ["load", m.model, "--context-length", String(size), "-y"]);
  const now = (await windowOf(m)).window;
  return { prefs: saved, change, applied: r.ok && now === size, window: now, ...(r.ok && now === size ? {} : { says: `LM Studio didn't load it at the new size: ${r.out.trim().split("\n").pop() || "no answer"}` }) };
}

async function changeFor(m: OwnModel, server: string | null, size: number): Promise<WindowChange> {
  const n = size.toLocaleString("en-US");
  if (server === "llamacpp") {
    const path = await presetFile();
    if (path) {
      const text = await readFile(path, "utf8").catch(() => null);
      if (text !== null) {
        const w = presetWith(text, m.model, size);
        return { how: "preset", file: path, section: m.model, line: w.line, before: w.before, says: `Friday changes ${w.line} under [${m.model}] in ${path.replace(os.homedir(), "~")}, then has llama.cpp load the model again.` };
      }
    }
    return { how: "manual", command: `llama-server … --ctx-size ${size}`, says: `Start llama-server with --ctx-size ${size} (or c = ${size} in its preset), then restart it. Friday didn't start this server, so it doesn't restart it.` };
  }
  if (server === "ollama") return { how: "manual", command: `OLLAMA_CONTEXT_LENGTH=${size} ollama serve`, says: `Ollama's OpenAI-format address takes no window. Run Ollama with OLLAMA_CONTEXT_LENGTH=${size}, or add PARAMETER num_ctx ${size} to a Modelfile for ${m.model}. Then it runs at ${n} tokens.` };
  if (server === "lmstudio") {
    const has = (await run("lms", ["version"])).ok;
    return has ? { how: "lms", command: `lms load ${m.model} --context-length ${size}`, says: `Friday has LM Studio load ${m.model} again at ${n} tokens.` } : { how: "manual", command: `lms load ${m.model} --context-length ${size}`, says: `Load it again in LM Studio at ${n} tokens, or run the command.` };
  }
  return { how: "manual", says: "Set the window where this server is started; Friday reads it from there." };
}
