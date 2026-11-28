/**
 * A thread's file edits over time, for the Captain page's Changes (Diff Timeline): each edit an agent made, when, to which file,
 * how many lines it put in and took out, and a few of its lines. Read from the log the thread already keeps (its tool calls'
 * arguments, rich-steps.ts editLines); nothing new is asked of the agents. An edit whose tool call failed is left out.
 */
import { editLines } from "./rich-steps.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

export interface ThreadEdit {
  /** Seconds after the thread's first edit. */
  at: number;
  file: string;
  added: number;
  removed: number;
  diff: string[];
}

export const EDITS_KEEP = 400;
const DIFF_LINES = 8;

/** A path as compared: forward slashes, no trailing one, and macOS's /private/var read as /var (one folder, two spellings). */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/private\/(var|tmp)\//, "/$1/");

/**
 * The file's path inside the project, as the list shows it: the folder's own prefix cut off. `folder` may be several roots: a
 * Captain's agent works in a copy of the project, and its copy's root stands for the project's (the audit, 2026-11-27: its edits
 * were filed "Outside the project").
 */
export function shortPath(file: string, folder?: string | readonly string[]): string {
  const f = norm(file);
  for (const r of typeof folder === "string" ? [folder] : (folder ?? [])) {
    const root = r ? norm(r) : "";
    if (root && f.startsWith(root + "/")) return f.slice(root.length + 1);
  }
  return file.replace(/\\/g, "/");
}

export function editsOf(events: readonly SessionEvent[], folder?: string | readonly string[], lane?: string): { start: number | null; edits: ThreadEdit[] } {
  const failed = new Set<string>();
  for (const ev of events) if (ev.body.type === "tool.result" && ev.body.isError) failed.add(ev.body.callId);
  const raw: { ts: number; file: string; added: number; removed: number; diff: string[] }[] = [];
  for (const ev of events) {
    if (ev.body.type !== "agent.message") continue;
    // One agent's lane only, when asked (a Captain's agents are lanes in its own session).
    if (lane !== undefined && (ev.lane ?? MAIN_LANE) !== lane) continue;
    for (const call of ev.body.toolCalls) {
      if (failed.has(call.id)) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!args || typeof args !== "object") continue;
      // Codex's edits: one call for several files, each with its unified diff (or, added, its content). Each file its own edit
      // (Arun, 2026-11-28: a crew on Codex showed "No changes yet" with every step done).
      if (Array.isArray(args.changes)) {
        for (const c of args.changes as { path?: unknown; kind?: unknown; diff?: unknown }[]) {
          const one = codexChange(c);
          if (one) raw.push({ ts: ev.ts, file: shortPath(one.path, folder), added: one.add.length, removed: one.del.length, diff: [...one.del.slice(0, DIFF_LINES / 2).map((l) => `-${l}`), ...one.add.slice(0, DIFF_LINES / 2).map((l) => `+${l}`)] });
        }
        continue;
      }
      const all = editLines(args, Number.MAX_SAFE_INTEGER);
      if (!all || !all.path) continue;
      const some = editLines(args, DIFF_LINES)!;
      raw.push({ ts: ev.ts, file: shortPath(all.path, folder), added: all.new.length + (all.old.length ? 0 : all.more), removed: all.old.length, diff: [...some.old.map((l) => `-${l}`), ...some.new.map((l) => `+${l}`)] });
    }
  }
  const kept = raw.slice(-EDITS_KEEP);
  const start = kept[0]?.ts ?? null;
  return { start, edits: kept.map((e) => ({ at: Math.max(0, Math.round((e.ts - start!) / 1000)), file: e.file, added: e.added, removed: e.removed, diff: e.diff })) };
}

/** One file of a Codex edit: its path and the lines put in and taken out, read from its diff; null when it has no path. */
export function codexChange(c: { path?: unknown; kind?: unknown; diff?: unknown } | null | undefined): { path: string; add: string[]; del: string[] } | null {
  if (!c || typeof c.path !== "string" || !c.path) return null;
  const kind = typeof c.kind === "string" ? c.kind : c.kind && typeof c.kind === "object" ? String((c.kind as { type?: unknown }).type ?? "") : "";
  const text = typeof c.diff === "string" ? c.diff : "";
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks = lines.some((l) => l.startsWith("@@"));
  // A new file's diff is its content (or a diff all of +); a deleted one's, all of -.
  if (!hunks && /add|create/i.test(kind)) return { path: c.path, add: lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)), del: [] };
  if (!hunks && /delete|remove/i.test(kind)) return { path: c.path, add: [], del: lines.map((l) => (l.startsWith("-") ? l.slice(1) : l)) };
  const add: string[] = [];
  const del: string[] = [];
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) add.push(l.slice(1));
    else if (l.startsWith("-")) del.push(l.slice(1));
  }
  return { path: c.path, add, del };
}
