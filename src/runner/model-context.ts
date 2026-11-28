import { execFile } from "node:child_process";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";

/**
 * What a local model's context window costs on this computer, and changing it (HANDOFF-local-models-2026-11-28, phase 3; the
 * mock's section 2): the model file's own header (GGUF) for its layers and attention, the window its server runs it at, the
 * memory each size takes, and, for llama.cpp in router mode, the preset file that sets it.
 *
 * Memory: the model file, plus the KV cache for the window (full-attention layers × KV heads × (key + value length) × bytes per
 * element), plus about 1.5 GB working room, against what the GPU may use (on Apple silicon about three quarters of the memory).
 */

export interface GgufInfo {
  arch: string;
  /** The longest window the model was trained for. */
  trained: number | null;
  layers: number;
  /** Layers that keep a growing cache: all of them, or one in `full_attention_interval` for a hybrid (qwen3.5's 17 of 65). */
  fullLayers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
}

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 } as const;
const SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** The header of a GGUF file: its key-value metadata, read from the first few megabytes (arrays of tokens skipped, not read). */
export async function readGguf(path: string): Promise<Record<string, unknown> | null> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const want = 16 * 1024 * 1024;
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.toString("latin1", 0, 4) !== "GGUF") return null;
    let at = 8;
    const u64 = () => {
      const v = Number(b.readBigUInt64LE(at));
      at += 8;
      return v;
    };
    const str = () => {
      const n = u64();
      const s = b.toString("utf8", at, at + n);
      at += n;
      return s;
    };
    const value = (type: number): unknown => {
      switch (type) {
        case T.U8: return b.readUInt8(at++);
        case T.I8: return b.readInt8(at++);
        case T.U16: return (at += 2), b.readUInt16LE(at - 2);
        case T.I16: return (at += 2), b.readInt16LE(at - 2);
        case T.U32: return (at += 4), b.readUInt32LE(at - 4);
        case T.I32: return (at += 4), b.readInt32LE(at - 4);
        case T.F32: return (at += 4), b.readFloatLE(at - 4);
        case T.BOOL: return b.readUInt8(at++) !== 0;
        case T.STRING: return str();
        case T.U64: return u64();
        case T.I64: return (at += 8), Number(b.readBigInt64LE(at - 8));
        case T.F64: return (at += 8), b.readDoubleLE(at - 8);
        case T.ARRAY: {
          const inner = b.readUInt32LE(at);
          at += 4;
          const n = u64();
          // Token lists run to hundreds of thousands: stepped over, never kept.
          if (inner !== T.STRING && SIZE[inner]) {
            const small = n <= 512 ? Array.from({ length: n }, () => value(inner)) : ((at += n * SIZE[inner]!), null);
            return small;
          }
          for (let i = 0; i < n; i++) value(inner);
          return null;
        }
        default: throw new Error(`gguf type ${type}`);
      }
    };
    at = 8;
    u64(); // tensors
    const count = u64();
    const out: Record<string, unknown> = {};
    for (let i = 0; i < count && at < b.length - 16; i++) {
      const key = str();
      const type = b.readUInt32LE(at);
      at += 4;
      out[key] = value(type);
    }
    return out;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** What the window math needs, out of a GGUF header. */
export function ggufInfo(meta: Record<string, unknown>): GgufInfo | null {
  const arch = typeof meta["general.architecture"] === "string" ? (meta["general.architecture"] as string) : "";
  if (!arch) return null;
  const n = (k: string) => {
    const v = meta[`${arch}.${k}`];
    return typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? Math.max(...(v as number[])) : null;
  };
  const layers = n("block_count") ?? 0;
  const heads = n("attention.head_count") ?? 0;
  const kvHeads = n("attention.head_count_kv") ?? heads;
  const embed = n("embedding_length") ?? 0;
  const keyLength = n("attention.key_length") ?? (heads ? Math.round(embed / heads) : 0);
  const valueLength = n("attention.value_length") ?? keyLength;
  const interval = n("full_attention_interval");
  const fullLayers = interval && interval > 1 ? Math.ceil(layers / interval) : layers;
  if (!layers || !kvHeads || !keyLength) return null;
  return { arch, trained: n("context_length"), layers, fullLayers, kvHeads, keyLength, valueLength };
}

/** Bytes per element of the KV cache for llama.cpp's cache types (q8_0 is 8.5 bits a value, f16 16). */
export const kvElement = (type: string | undefined) => (/^q8/i.test(type ?? "") ? 1.0625 : /^q4/i.test(type ?? "") ? 0.5625 : /^q5/i.test(type ?? "") ? 0.6875 : 2);

/** KV cache bytes per token of window. */
export const kvPerToken = (g: GgufInfo, kType?: string, vType?: string) => g.fullLayers * g.kvHeads * (g.keyLength * kvElement(kType) + g.valueLength * kvElement(vType ?? kType));

/** What the GPU may use here: on Apple silicon about three quarters of the memory (Metal's working set), else all of it. */
export const gpuLimit = () => (process.platform === "darwin" && process.arch === "arm64" ? Math.round(os.totalmem() * 0.75) : os.totalmem());

/** Working room besides the model and its cache, as the mock counts it. */
export const WORKING = 1.5e9;

/** The window sizes offered (the mock's 32k to 256k), up to what the model was trained for. */
export function windowSizes(trained: number | null): number[] {
  const all = [32_768, 65_536, 98_304, 131_072, 262_144];
  return all.filter((s) => !trained || s <= trained);
}

// ── llama.cpp in router mode: its preset file ──────────────────────────────

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, { timeout: 3_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ""))));

/** The preset file a running llama-server router was started with (--models-preset), found among this computer's processes. */
export async function presetFile(): Promise<string | null> {
  // The tests' stand-in llama.cpp, which is no llama-server among the processes.
  if (process.env.FRIDAY_LLAMA_PRESET) return process.env.FRIDAY_LLAMA_PRESET;
  if (process.platform === "win32") return null;
  const ps = await run("ps", ["-axo", "args="]);
  for (const line of ps.split("\n")) {
    if (!/llama-server/.test(line)) continue;
    const m = /--models-preset[= ]+(\S+)/.exec(line);
    if (m) return m[1]!.replace(/^~(?=\/)/, os.homedir());
  }
  return null;
}

/** A model's own `c =` in a preset file, and the file with it set to `window` under the model's own section (the [*] default kept). */
export function presetWith(text: string, model: string, window: number): { text: string; before: number | null; line: string } {
  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const head = (l: string) => /^\s*\[(.+)\]\s*$/.exec(l)?.[1]?.trim();
  const start = lines.findIndex((l) => head(l) === model);
  const line = `c = ${window}`;
  if (start < 0) {
    // No section of its own: one made, with just this line, so the shared default stays as it is.
    return { text: `${text.replace(/\s*$/, "")}${eol}${eol}[${model}]${eol}${line}${eol}`, before: null, line };
  }
  let end = lines.findIndex((l, i) => i > start && head(l) !== undefined);
  if (end < 0) end = lines.length;
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*(?:c|ctx-size|ctx_size)\s*=\s*(\d+)/.exec(lines[i]!);
    if (m) {
      const before = Number(m[1]);
      lines[i] = line;
      return { text: lines.join(eol), before, line };
    }
  }
  lines.splice(start + 1, 0, line);
  return { text: lines.join(eol), before: null, line };
}

/** Writes a preset file's new text, the old one kept beside it as `.bak`, in one rename so llama.cpp never reads half of it. */
export async function writePreset(path: string, text: string): Promise<void> {
  const old = await readFile(path, "utf8");
  await writeFile(`${path}.bak`, old);
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

/** A file's size, or null. */
export const sizeOf = (path: string) => stat(path).then((s) => s.size, () => null);
