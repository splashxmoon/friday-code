// Every coding tool held to the same promises (Arun, 2026-11-27: "fix uneven across tools"; docs/coding-tools-parity.md): Friday's
// MCP server reaches Crush and Muse as it does the others, Crush runs in Plan with its editing and shell tools hidden, a mode a tool
// can't honour is said plainly in one place, tools without the agent tools aren't told to use them, a limit in a key-based tool's
// words reaches the hand-off, and every tool's usage card says something true.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ADAPTERS, CRUSH_PLAN_DENY, crushConfig, crushConfigDir, looseJson, muse, museMcp, museQuota, plainText, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { museFrom, SAID_LIMITS } from "../src/runner/tool-limits.js";
import { limitHit, planLimitHit } from "../src/limit-reset.js";
import { meshHead } from "../src/mesh-note.js";
import { promptFor } from "../src/engine/hub.js";
import { ENGINE_TOOLS, modeRefusal, NO_AGENT_TOOLS, TOOL_MODES, type MeshNote, type SessionEvent } from "../src/types.js";

const friday = { command: "/usr/local/bin/node", args: ["/home/me/.friday/friday-mcp.mjs"], env: { FRIDAY_MESH_FILE: "/home/me/.friday/mesh/abc.url" } };
const spec = (s: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "Look", system: "", resumeId: null, mode: "full", ...s });
const run = (parse: ReturnType<typeof plainText>, lines: string[], code: number | null = 0): AdapterOut[] => [...lines.flatMap((l) => parse(l)), ...(parse.end?.(code) ?? [])];

// ── modes ────────────────────────────────────────────────────────────

test("a mode a tool can't be held to is refused in one place, with why, and the adapters agree with it", () => {
  for (const t of ENGINE_TOOLS) {
    const declared = TOOL_MODES[t]?.modes;
    assert.deepEqual(ADAPTERS[t].modes, declared, `${t}: the runner and the pickers read the same modes`);
  }
  assert.match(modeRefusal("amp", "plan")!, /only in Auto/);
  assert.match(modeRefusal("aider", "edits")!, /Auto, or in Plan/);
  assert.match(modeRefusal("crush", "edits")!, /Plan/);
  assert.equal(modeRefusal("crush", "plan"), null);
  assert.equal(modeRefusal("aider", "plan"), null);
  assert.equal(modeRefusal("claude", "edits"), null);
  assert.equal(modeRefusal(undefined, "edits"), null);
});

// ── Crush ────────────────────────────────────────────────────────────

function crushHome() {
  const home = mkdtempSync(path.join(tmpdir(), "friday-crush-"));
  const real = path.join(home, ".config", "crush");
  mkdirSync(real, { recursive: true });
  return { home, real, env: {} as NodeJS.ProcessEnv };
}

test("Crush: nothing changes for a turn that needs neither Friday's server nor Plan", () => {
  const { home, env } = crushHome();
  assert.equal(crushConfig(spec(), env, home), null);
  assert.deepEqual(ADAPTERS.crush.env!(spec()), {});
});

test("Crush: Friday's MCP server goes in a config of Friday's that is the person's own plus it, their context files still named", () => {
  const { home, real, env } = crushHome();
  // Their own config, written as Crush's docs write it: a comment and trailing commas.
  writeFileSync(path.join(real, "crush.json"), `{\n  // mine\n  "providers": { "anthropic": { "api_key": "$ANTHROPIC_API_KEY", }, },\n  "mcp": { "db": { "type": "stdio", "command": "db-mcp" } },\n  "options": { "debug": true },\n}\n`);
  const dir = crushConfig(spec({ friday }), env, home)!;
  assert.ok(dir.startsWith(path.join(home, ".friday", "crush")));
  const j = JSON.parse(readFileSync(path.join(dir, "crush.json"), "utf8"));
  assert.deepEqual(j.providers, { anthropic: { api_key: "$ANTHROPIC_API_KEY" } });
  assert.deepEqual(j.mcp.db, { type: "stdio", command: "db-mcp" });
  assert.deepEqual(j.mcp.friday, { type: "stdio", command: friday.command, args: friday.args, env: friday.env, timeout: 30 });
  assert.equal(j.options.debug, true);
  assert.deepEqual(j.options.global_context_paths, [path.join(real, "CRUSH.md"), path.join(home, ".config", "AGENTS.md")]);
  assert.equal(j.options.disabled_tools, undefined, "Auto hides nothing");
  assert.ok(!existsSync(path.join(dir, "crushrc")), "no crushrc of theirs, none of Friday's");
  // The same turn again uses the same folder.
  assert.equal(crushConfig(spec({ friday }), env, home), dir);
});

test("Crush: their own crush.json that isn't JSON is left to run alone outside Plan, never rewritten", () => {
  const { home, real, env } = crushHome();
  writeFileSync(path.join(real, "crush.json"), "{ not json");
  assert.equal(crushConfig(spec({ friday }), env, home), null);
});

test("Crush in Plan: its editing and shell tools are hidden in the JSON and, after their own crushrc, in a crushrc of Friday's", () => {
  const { home, real, env } = crushHome();
  writeFileSync(path.join(real, "crush.json"), JSON.stringify({ options: { disabled_tools: ["sourcegraph"] } }));
  writeFileSync(path.join(real, "crushrc"), "provider add ollama --type ollama\n");
  const dir = crushConfig(spec({ mode: "plan" }), env, home)!;
  const j = JSON.parse(readFileSync(path.join(dir, "crush.json"), "utf8"));
  assert.deepEqual(j.options.disabled_tools, ["sourcegraph", ...CRUSH_PLAN_DENY]);
  for (const t of ["bash", "edit", "multiedit", "write"]) assert.ok(CRUSH_PLAN_DENY.includes(t));
  assert.equal(j.mcp, undefined, "no Friday server was given");
  const rc = readFileSync(path.join(dir, "crushrc"), "utf8").split("\n");
  assert.equal(rc[1], `source '${path.join(real, "crushrc").replace(/\\/g, "/")}'`);
  assert.equal(rc[2], `permissions deny ${CRUSH_PLAN_DENY.join(" ")}`);
  // Plan with a config that can't be read still runs with Friday's folder: never a Plan turn that can edit.
  writeFileSync(path.join(real, "crush.json"), "{ broken");
  const blind = crushConfig(spec({ mode: "plan" }), env, home)!;
  assert.deepEqual(JSON.parse(readFileSync(path.join(blind, "crush.json"), "utf8")).options.disabled_tools, CRUSH_PLAN_DENY);
});

test("Crush's config folder is found where Crush finds it, CRUSH_GLOBAL_CONFIG and XDG first, on Windows too", () => {
  assert.equal(crushConfigDir({ CRUSH_GLOBAL_CONFIG: "/x/cfg" }, "/home/me"), "/x/cfg");
  assert.equal(crushConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/me"), path.join("/xdg", "crush"));
  assert.equal(crushConfigDir({}, "/home/me"), path.join("/home/me", ".config", "crush"));
});

test("loose JSON: comments and trailing commas go, strings keep their slashes and commas", () => {
  assert.deepEqual(looseJson(`{ "url": "http://x/y", /* c */ "a": [1, 2,], "s": "a, ]", }`), { url: "http://x/y", a: [1, 2], s: "a, ]" });
  assert.deepEqual(looseJson(`{"p": "C:\\\\Users\\\\me"}`), { p: "C:\\Users\\me" });
  assert.equal(looseJson("{ nope"), null);
});

test("Crush's CRLF output reads as its answer, and its Plan turns are offered", () => {
  const outs = run(ADAPTERS.crush.parser(spec()), ["Line one.\r", "Line two.\r"]);
  assert.deepEqual(outs.find((o) => o.kind === "message"), { kind: "message", text: "Line one.\nLine two.", toolCalls: [] });
  assert.deepEqual(ADAPTERS.crush.modes, ["full", "plan"]);
});

// ── Muse ─────────────────────────────────────────────────────────────

test("Muse: Friday's server is asked for with sessionMcp and goes with session/start only once Muse grants it", () => {
  assert.deepEqual(JSON.parse(muse.stdin(spec({ friday }))).params.capabilities.requestedCapabilities, ["sessionMcp"]);
  assert.deepEqual(JSON.parse(muse.stdin(spec())).params.capabilities.requestedCapabilities, []);
  assert.deepEqual(museMcp(friday, ["sessionMcp"]), { config: { mcpServers: { friday: { transport: "stdio", command: friday.command, args: friday.args, env: friday.env, mode: "optional" } } } });
  assert.deepEqual(museMcp(friday, []), {});
  assert.deepEqual(museMcp(undefined, ["sessionMcp"]), {});

  const sent: any[] = [];
  const parse = muse.parser(spec({ friday }), { cwd: "/work", write: (l) => void sent.push(JSON.parse(l)), end: () => {} });
  parse(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { grantedCapabilities: ["sessionMcp"] } }));
  const start = sent.find((m) => m.method === "session/start");
  assert.equal(start.params.config.mcpServers.friday.command, friday.command);
  // An older Muse that grants nothing: the conversation opens as before.
  const old: any[] = [];
  muse.parser(spec({ friday }), { cwd: "/work", write: (l) => void old.push(JSON.parse(l)), end: () => {} })(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
  assert.equal(old.find((m) => m.method === "session/start").params.config, undefined);
  // A conversation carried on gets it too.
  const again: any[] = [];
  muse.parser(spec({ friday, resumeId: "s-1" }), { cwd: "/work", write: (l) => void again.push(JSON.parse(l)), end: () => {} })(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { grantedCapabilities: ["sessionMcp"] } }));
  assert.ok(again.find((m) => m.method === "session/resume").params.config.mcpServers.friday);
});

test("Muse: a turn refused on its plan's allowance is said as a usage limit with when it lifts", () => {
  const now = Date.UTC(2026, 10, 27, 12, 0);
  const said = museQuota({ kind: "quota", message: "Allowance used up", quota: { limitKind: "tierLimit", resetsAtMs: now + 135 * 60_000 } }, now)!;
  assert.match(said, /usage limit, resets in 2 hours 15 minutes\. Allowance used up/);
  assert.equal(planLimitHit(said, now)?.resetsAt, now + 135 * 60_000);
  assert.equal(museQuota({ kind: "provider", message: "boom" }, now), null);
});

test("Muse's allowance: five hours and the week, in the wire's camelCase or its snapshot's snake_case", () => {
  const camel = museFrom({ observedAtMs: 1, tier: "everyday_usage", window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: 1_800_000_000_000 }, weekly: { usedPercent: 7, resetsAtMs: 1_800_500_000_000 } })!;
  assert.equal(camel.plan, "Everyday usage");
  assert.deepEqual(camel.windows.map((w) => [w.kind, w.label, w.usedPercent, w.resetsAt, w.windowMinutes]), [
    ["session", "5h", 42, 1_800_000_000, 300],
    ["weekly", "Weekly", 7, 1_800_500_000, 10080],
  ]);
  const snake = museFrom({ usage: { tier: "high", window: { used_percent: 100, window_duration_mins: 300, resets_at: "2027-01-15T08:00:00Z" }, weekly: { used_percent: 55, resets_at: 1_800_000_000 } } })!;
  assert.deepEqual(snake.windows.map((w) => [w.usedPercent, w.resetsAt]), [
    [100, Date.parse("2027-01-15T08:00:00Z") / 1000],
    [55, 1_800_000_000],
  ]);
  assert.equal(museFrom({ hello: 1 }), null);
});

test("every tool with no readable allowance says why instead of 'Not shared', and invents no numbers", () => {
  for (const t of ["aider", "goose", "crush", "pi", "qwen", "auggie", "junie"] as const) {
    assert.ok(SAID_LIMITS[t]?.why, t);
    assert.doesNotMatch(SAID_LIMITS[t]!.why, /\d+ (?:requests|messages|%)/, `${t} names no figure`);
  }
  assert.equal(SAID_LIMITS.aider!.plan, "Your API key");
});

// ── Aider and limits ─────────────────────────────────────────────────

test("Aider giving up on its provider after its retries ends the turn on that error, which the hand-off reads as a limit", () => {
  const lines = [
    "litellm.RateLimitError: AnthropicException - {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    "The API provider has rate limited you. Try again later or check your quotas.",
    "Retrying in 0.2 seconds...",
    "litellm.RateLimitError: AnthropicException - {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    "The API provider has rate limited you. Try again later or check your quotas.",
  ];
  const outs = run(ADAPTERS.aider.parser(spec({ ephemeral: true })), lines);
  const done = outs.filter((o) => o.kind === "done");
  assert.equal(done.length, 1);
  assert.match(done[0]!.kind === "done" ? done[0]!.error ?? "" : "", /rate limited you/);
  assert.ok(limitHit(done[0]!.kind === "done" ? done[0]!.error : undefined));
  assert.ok(!outs.some((o) => o.kind === "delta" && o.channel === "text"), "its errors aren't its answer");

  // Retried and then answered: a clean turn.
  const ok = run(ADAPTERS.aider.parser(spec({ ephemeral: true })), [lines[0]!, lines[1]!, lines[2]!, "Here is the fix."]);
  assert.deepEqual(ok.at(-1), { kind: "done" });
});

test("limit words in the key-based tools' own wording reach the hand-off; paid credits run out aren't a limit that comes back", () => {
  for (const said of ["litellm.RateLimitError: rate_limit_error", "insufficient_quota", "RESOURCE_EXHAUSTED: Quota exceeded"]) assert.ok(limitHit(said), said);
  // Nothing resets these: the person tops up, and the run stays Stopped in Needs you (board.test.ts).
  for (const said of ["Your credit balance is too low to access the Anthropic API", "You are out of credits", "Insufficient Balance"]) assert.equal(limitHit(said), null, said);
  assert.equal(limitHit("Error: Cannot find module 'x'"), null);
  assert.equal(limitHit("generating a separate report"), null);
});

// ── tools without the agent tools ────────────────────────────────────

test("Aider and Pi aren't told to use agent tools they don't have; their last message is still their answer", () => {
  assert.ok(NO_AGENT_TOOLS.has("aider") && NO_AGENT_TOOLS.has("pi") && !NO_AGENT_TOOLS.has("crush") && !NO_AGENT_TOOLS.has("muse"));
  const ask: MeshNote = { kind: "ask", id: "q1", fromLane: "l2", fromName: "Codex" } as unknown as MeshNote;
  assert.match(meshHead(ask), /reply_to_agent/);
  assert.doesNotMatch(meshHead(ask, false), /reply_to_agent|ask_agent|list_tasks|claim_task/);
  assert.match(meshHead(ask, false), /your last message this turn goes back to Codex/);
  const task: MeshNote = { kind: "task", id: "t1", fromLane: "l2", fromName: "Codex", board: true } as unknown as MeshNote;
  assert.doesNotMatch(meshHead(task, false), /ask_agent|post_update|list_tasks|claim_task/);

  const board = { seq: 1, ts: 0, sid: "s", actor: { kind: "human", id: "u", name: "Arun" }, body: { type: "instruction", text: "Build it", board: true } } as unknown as SessionEvent;
  assert.match(promptFor([board], [1]).prompt, /post_tasks/);
  assert.doesNotMatch(promptFor([board], [1], [], "", "", false).prompt, /post_tasks/);
});
