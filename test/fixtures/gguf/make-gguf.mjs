// A GGUF file with just a header, for the window math (runner/model-context.ts): `makeGguf(path, kv, size)` writes version 3, no
// tensors, the key-values given, then makes the file `size` bytes long as a sparse file, so it reads as a 20.9 GB model without
// taking the room.
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";

export function makeGguf(path, kv, size = 0) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); u64(b.length); parts.push(b); };
  parts.push(Buffer.from("GGUF"));
  u32(3);
  u64(0);
  u64(Object.keys(kv).length);
  for (const [k, v] of Object.entries(kv)) {
    str(k);
    if (typeof v === "string") { u32(8); str(v); } else { u32(4); u32(v); }
  }
  const fd = openSync(path, "w");
  writeSync(fd, Buffer.concat(parts));
  if (size) ftruncateSync(fd, size);
  closeSync(fd);
}

/** lab-coder-27b's header, as the handoff read it: a qwen3.5 hybrid, 17 of 65 layers with full attention. */
export const QWEN_HYBRID = { "general.architecture": "qwen35", "qwen35.block_count": 65, "qwen35.context_length": 262144, "qwen35.embedding_length": 5120, "qwen35.attention.head_count": 24, "qwen35.attention.head_count_kv": 4, "qwen35.attention.key_length": 256, "qwen35.attention.value_length": 256, "qwen35.full_attention_interval": 4 };
