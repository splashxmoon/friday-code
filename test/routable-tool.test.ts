// A model routed on one coding tool is never carried over to another (hub.ts autoRoute): a crew mate moved from Claude Code to
// Codex as its usage ran out was sent out on "haiku", which Codex refused (Arun, 2026-11-27).
import assert from "node:assert/strict";
import { test } from "node:test";
import { routable } from "../src/routing.js";

test("a tool's routed model counts as the one it is on only when that tool has it", () => {
  assert.equal(routable("claude", "haiku"), true);
  assert.equal(routable("codex", "haiku"), false, "Claude Code's model is not Codex's");
  assert.equal(routable("codex", "gpt-6-luna"), true);
  assert.equal(routable("claude", "gpt-6-luna"), false);
  assert.equal(routable("codex", null), false);
  assert.equal(routable("cursor", "haiku"), false, "a tool with nothing to route to keeps nothing");
});
