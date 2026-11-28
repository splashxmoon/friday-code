import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readJson, updateJson } from "../safe-file.js";

/**
 * A project's MCP servers, as an ACP tool is handed them when a conversation opens (`session/new`, `session/load`).
 *
 * The project's `.mcp.json` is the one MCP file most tools and teams share, and Claude Code reads it by itself. The tools Friday
 * speaks to over ACP each read only their own config, and Friday passed them none (`mcpServers: []`), so a project's servers were
 * there for Claude Code and nobody else. ACP's way is for the client to pass them, so Friday does now (Arun, 2026-10-18: every
 * tool as capable in Friday as on its own). Only the project's own file: the person's own servers are each tool's own business.
 *
 * Only the servers this computer's owner has said yes to, though. The file comes with the repository (a clone, a pull request's
 * branch), and a server in it is a command run as the person, or an address sent their keys by `${VAR}`. So each server is
 * asked about once per folder, as Claude Code asks for its own, and again whenever its entry changes; until then it is not
 * passed and nothing of the environment is filled into it (Security H3).
 */

type Pair = { name: string; value: string };
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Pair[] }
  | { type: "http" | "sse"; name: string; url: string; headers: Pair[] };

/**
 * `${VAR}` and `${VAR:-default}` filled in from the environment, as Claude Code does in .mcp.json. Null when one is unset and
 * has no default: that server couldn't start as written, so it isn't passed rather than passed broken.
 */
export function expandVars(s: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let missing = false;
  const out = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (dflt !== undefined) return dflt;
    missing = true;
    return "";
  });
  return missing ? null : out;
}

const pairs = (o: unknown, env: NodeJS.ProcessEnv): Pair[] | null => {
  if (!o || typeof o !== "object") return [];
  const out: Pair[] = [];
  for (const [name, raw] of Object.entries(o as Record<string, unknown>)) {
    const value = expandVars(String(raw ?? ""), env);
    if (value === null) return null;
    out.push({ name, value });
  }
  return out;
};

/** One server as the file has it, nothing filled in: what the person is shown, and what their yes is a yes to. */
export type McpEntry = { name: string; hash: string; shown: string; raw: Record<string, any> };

/** Keys in one order at every depth, so the same entry written another way round is the same entry. */
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The servers in a folder's .mcp.json, as written. A file that is missing or broken is none. */
export async function projectMcpEntries(cwd: string): Promise<McpEntry[]> {
  const j = await readFile(path.join(cwd, ".mcp.json"), "utf8")
    .then((t) => JSON.parse(t) as { mcpServers?: Record<string, any> })
    .catch(() => null);
  const servers = j?.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
  const out: McpEntry[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || s.disabled === true) continue;
    const stdio = typeof s.command === "string" && !!s.command.trim();
    if (!stdio && !(typeof s.url === "string" && s.url.trim())) continue;
    // The whole entry, name included: a changed argument, variable, address or header is another server to ask about.
    const hash = createHash("sha256").update(JSON.stringify(stable([name, s]))).digest("hex");
    // As written, so a `${KEY}` reads as its name and never as its value. One line: the card shows one.
    const what = stdio ? [s.command, ...(Array.isArray(s.args) ? s.args : [])].map(String).join(" ") : String(s.url);
    out.push({ name, hash, shown: clip(`${name}: ${what}`.replace(/\s+/g, " "), 200), raw: s });
  }
  return out;
}

type Decisions = Record<string, Record<string, "yes" | "no">>;
const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const decisionsFile = () => path.join(stateDir(), "mcp-approved.json");
const decisionsShape = (j: unknown): Decisions | null => (j && typeof j === "object" && !Array.isArray(j) ? (j as Decisions) : null);
/** One name per folder however it was reached (a symlink, a trailing slash). */
const folderKey = (folder: string) => realpath(folder).catch(() => path.resolve(folder));

/** What this computer's owner has answered for a folder's servers, by entry (see McpEntry.hash). */
export async function mcpDecisions(folder: string): Promise<Record<string, "yes" | "no">> {
  const all = await readJson(decisionsFile(), decisionsShape, () => ({}) as Decisions).catch(() => ({}) as Decisions);
  const mine = all[await folderKey(folder)];
  return mine && typeof mine === "object" ? mine : {};
}

/** Their answer, kept: a yes passes those entries from the next turn on, a no stops them being asked about again. */
export async function decideMcp(folder: string, hashes: string[], yes: boolean): Promise<void> {
  const key = await folderKey(folder);
  await updateJson(decisionsFile(), { shape: decisionsShape, empty: () => ({}) as Decisions, mode: 0o600 }, (all) => {
    const mine = (all[key] = all[key] && typeof all[key] === "object" ? all[key] : {});
    for (const h of hashes) mine[h] = yes ? "yes" : "no";
  });
}

/** The first words of the card that asks (see Runner.askMcp): how a yes to it is told from a yes to a command. */
export const MCP_ASK = "Use this project's MCP servers";

/**
 * The servers in a folder's .mcp.json its owner said yes to, as ACP names them, and those nobody has answered for yet.
 * `folder` is where the answers are kept under: the project itself for a copy of it, so a teammate's copy doesn't ask again
 * for the very entries already answered.
 */
export async function projectMcp(cwd: string, env: NodeJS.ProcessEnv = process.env, folder = cwd): Promise<{ servers: AcpMcpServer[]; pending: McpEntry[] }> {
  const entries = await projectMcpEntries(cwd);
  if (!entries.length) return { servers: [], pending: [] };
  const said = await mcpDecisions(folder);
  const servers: AcpMcpServer[] = [];
  const pending: McpEntry[] = [];
  for (const e of entries) {
    if (said[e.hash] !== "yes") {
      if (said[e.hash] !== "no") pending.push(e);
      continue;
    }
    const { name, raw: s } = e;
    if (typeof s.command === "string" && s.command.trim()) {
      const command = expandVars(s.command, env);
      const args = (Array.isArray(s.args) ? s.args : []).map((a: unknown) => expandVars(String(a), env));
      const vars = pairs(s.env, env);
      if (command === null || args.includes(null) || vars === null) continue;
      servers.push({ name, command, args: args as string[], env: vars });
    } else {
      const url = expandVars(s.url, env);
      const headers = pairs(s.headers, env);
      if (url === null || headers === null) continue;
      servers.push({ type: s.type === "sse" ? "sse" : "http", name, url, headers });
    }
  }
  return { servers, pending };
}

/** Only the approved ones (see projectMcp). */
export async function projectMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env, folder = cwd): Promise<AcpMcpServer[]> {
  return (await projectMcp(cwd, env, folder)).servers;
}

/** Those an agent can take: every one that it starts itself, and the remote ones only when it says it speaks their transport. */
export function mcpForAgent(servers: AcpMcpServer[] | undefined, caps: Record<string, any> | undefined): AcpMcpServer[] {
  const remote = caps?.mcpCapabilities ?? caps?.mcp ?? {};
  return (servers ?? []).filter((s) => !("type" in s) || (s.type === "http" ? !!remote.http : !!remote.sse));
}
