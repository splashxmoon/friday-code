import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ggufInfo, kvPerToken, presetWith, readGguf, windowSizes } from "../src/runner/model-context.js";
// @ts-expect-error a plain .mjs fixture, without types
import { makeGguf, QWEN_HYBRID } from "./fixtures/gguf/make-gguf.mjs";

/** What a local model's window costs (runner/model-context.ts; HANDOFF-local-models-2026-11-28, phase 3). */

test("a GGUF header read for its layers and attention; a hybrid counts only its full-attention layers", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "gguf-")), "lab-coder.gguf");
  makeGguf(file, QWEN_HYBRID, 20_900_000_000);
  const meta = await readGguf(file);
  const g = ggufInfo(meta!)!;
  assert.deepEqual({ arch: g.arch, trained: g.trained, layers: g.layers, fullLayers: g.fullLayers, kvHeads: g.kvHeads, keyLength: g.keyLength }, { arch: "qwen35", trained: 262144, layers: 65, fullLayers: 17, kvHeads: 4, keyLength: 256 });
  // The handoff's figure: about 37 KB a token at q8_0, about 1.2 GB per 32k.
  const per = kvPerToken(g, "q8_0", "q8_0");
  assert.ok(Math.abs(per - 36_992) < 1, `${per}`);
  assert.ok(Math.abs((per * 32_768) / 1e9 - 1.21) < 0.02);
  assert.deepEqual(windowSizes(g.trained), [32_768, 65_536, 98_304, 131_072, 262_144]);
  assert.deepEqual(windowSizes(131_072), [32_768, 65_536, 98_304, 131_072]);
  // A plain llama: every layer keeps a cache (an 8B llama: 32 layers, 8 KV heads, 128): about 70 KB a token.
  const llama = ggufInfo({ "general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8, "llama.embedding_length": 4096, "llama.context_length": 131072 })!;
  assert.equal(llama.fullLayers, 32);
  assert.ok(Math.abs(kvPerToken(llama, "q8_0") - 69_632) < 1);
});

test("the preset's own line for one model: changed in its section, added to it, or a section made; the [*] default kept", () => {
  const ini = "[*]\nc = 32768\nfa = on\n\n[lab-coder-27b]\nmodel = /m/q.gguf\nc = 32768\n\n[lab-helper-8b]\nmodel = /m/f.gguf\n";
  const a = presetWith(ini, "lab-coder-27b", 65536);
  assert.equal(a.before, 32768);
  assert.match(a.text, /\[\*\]\nc = 32768\n/);
  assert.match(a.text, /\[lab-coder-27b\]\nmodel = \/m\/q\.gguf\nc = 65536\n/);
  const b = presetWith(ini, "lab-helper-8b", 98304);
  assert.equal(b.before, null);
  assert.match(b.text, /\[lab-helper-8b\]\nc = 98304\nmodel = \/m\/f\.gguf/);
  const c = presetWith(ini, "new-model", 65536);
  assert.match(c.text, /\n\n\[new-model\]\nc = 65536\n$/);
  assert.match(c.text, /^\[\*\]\nc = 32768/);
});
