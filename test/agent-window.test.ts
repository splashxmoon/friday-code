import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext } from "../src/agent/context.js";
import { CHARS_PER_TOKEN, messageChars, overflowOf, roomError, WindowBook } from "../src/agent/window.js";
import type { SessionEvent } from "../src/types.js";

/**
 * An own model's window (agent/window.ts; HANDOFF-local-models-2026-11-28, phase 1): read out of every server's overflow error,
 * a budget in tokens that leaves room for the instructions, the tools and the reply, and a history fitted to it.
 */

test("the window, and the request's size, out of each server's overflow error", () => {
  assert.deepEqual(overflowOf("request (36664 tokens) exceeds the available context size (32768 tokens), try increasing it"), { window: 32768, asked: 36664 });
  assert.deepEqual(overflowOf("This model's maximum context length is 8192 tokens. However, your messages resulted in 9,000 tokens. Please reduce the length of the messages."), { window: 8192, asked: 9000 });
  assert.deepEqual(overflowOf("This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4000 in the messages, 1000 in the completion)."), { window: 4096, asked: 5000 });
  assert.deepEqual(overflowOf("Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 8192 tokens, which is not enough."), { window: 8192, asked: 9000 });
  assert.equal(overflowOf("the input length exceeds the context length")?.window, null);
  assert.ok(overflowOf("error: context_length_exceeded"));
  assert.equal(overflowOf("401 invalid api key"), null);
  assert.equal(overflowOf("Rate limit reached, try again in 20s"), null);
});

test("the budget is the window less the reply's room, the instructions and the tools, in this model's characters per token", () => {
  const book = new WindowBook(async () => ({ window: 32_768 }));
  assert.equal(book.budget("m", null, 10_000), null, "no window known: the old fixed ceiling stays");
  const b = book.budget("m", 32_768, 20_000)!;
  assert.equal(b, Math.floor((32_768 - 4096) * CHARS_PER_TOKEN) - 20_000);
  assert.ok(book.budget("m", 32_768, 20_000, 4096, 0.85)! < b, "the retry after an overflow is fitted tighter");
  assert.equal(book.budget("m", 8_000, 400_000), 2_000, "never less than a little history");
});

test("what a server counts and what an overflow says teach the ratio; an overflow's window is believed at once", async () => {
  let asked = 0;
  const book = new WindowBook(async () => (asked++, { window: 65_536 }));
  assert.equal(await book.window("m"), 65_536);
  assert.equal(await book.window("m"), 65_536);
  assert.equal(asked, 1, "asked once, then kept");
  book.counted("m", 40_000, 10_000);
  assert.ok(Math.abs(book.ratio("m") - (CHARS_PER_TOKEN + 4) / 2) < 1e-9, "eased toward what the server counted");
  book.overflowed("m", { window: 32_768, asked: 36_664 }, 110_000);
  assert.equal(await book.window("m"), 32_768, "the error's window, until the server is asked again");
  assert.ok(Math.abs(book.ratio("m") - 110_000 / 36_664) < 1e-9);
});

const ev = (seq: number, body: SessionEvent["body"], actor: SessionEvent["actor"] = { kind: "agent", id: "friday", name: "Friday" }): SessionEvent => ({ seq, ts: seq, sid: "s", actor, body }) as SessionEvent;
const human = { kind: "human" as const, id: "u", name: "Arun" };

test("history fitted to a budget: older turns go first, and one huge output is cut to its start and end", () => {
  const events: SessionEvent[] = [];
  let seq = 1;
  events.push(ev(seq++, { type: "instruction", text: "Recon of the lab subnet." } as never, human));
  events.push(ev(seq++, { type: "instructions.delivered", seqs: [1] } as never));
  for (let i = 0; i < 12; i++) {
    events.push(ev(seq++, { type: "agent.message", text: `Step ${i}`, toolCalls: [{ id: `c${i}`, name: "read_file", args: { path: `notes/${i}.md` } }] } as never));
    events.push(ev(seq++, { type: "tool.result", callId: `c${i}`, name: "read_file", output: `file ${i} `.repeat(400) } as never));
  }
  const all = buildContext(events);
  const fitted = buildContext(events, { budget: 12_000 });
  assert.ok(messageChars(all) > 30_000);
  assert.ok(messageChars(fitted) <= 13_500, `fits: ${messageChars(fitted)}`);
  assert.equal((fitted[0]!.content as string).includes("Recon of the lab subnet."), true, "the opening instruction stays");
  assert.ok(fitted.some((m) => typeof m.content === "string" && m.content.includes("earlier turns were dropped")), "says what went");

  // The last turn is one output bigger than the whole budget: kept, but cut to its start and end, saying so.
  const huge = [...events, ev(seq++, { type: "agent.message", text: "cat the log", toolCalls: [{ id: "big", name: "run_command", args: { command: "cat scan.log" } }] } as never), ev(seq++, { type: "tool.result", callId: "big", name: "run_command", output: "HEAD " + "x".repeat(60_000) + " TAIL" } as never)];
  const cut = buildContext(huge, { budget: 9_000 });
  const out = cut.find((m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("HEAD"))!.content as string;
  assert.ok(out.endsWith("TAIL") && /characters (?:cut from|left out of) the middle of this/.test(out), out.slice(0, 200));
  assert.ok(messageChars(cut) <= 10_500, `fits: ${messageChars(cut)}`);
});

test("what the thread says when it still doesn't fit names both sizes, never the server's raw text", () => {
  assert.match(roomError({ window: 32768, asked: 36664 }, null, 0), /^Out of room: 36,664 tokens asked, and its window is 32,768\./);
  assert.match(roomError({ window: null, asked: null }, 16_384, 20_000), /^Out of room: 20,000 tokens asked, and its window is 16,384\./);
});
