/**
 * What a step's tool call says at a glance, read from its arguments and output, for the richer steps in Arun's own build
 * (client/RichSteps.tsx; Arun, 2026-11-02: "tool calls and commands and stuff too i think it would enhance the visuals too").
 * Nothing new is asked of the agents: a test run's counts, an edit's lines, a search's files are all in the log already.
 */

// Colours out, and Windows' \r\n as \n: a runner on Windows ends its summary lines "ℹ pass 41\r".
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * A test run's counts, from the summary line its runner prints last: node:test's "ℹ pass 41", jest's "Tests: 2 failed, 41
 * passed", vitest's "Tests  41 passed | 2 failed", pytest's "2 failed, 41 passed in 1.2s", cargo's "41 passed; 2 failed".
 * Null when the output says none.
 */
export function testCounts(output: string): TestCounts | null {
  const text = strip(output);
  const node = { passed: /^ℹ pass (\d+)$/m.exec(text), failed: /^ℹ fail (\d+)$/m.exec(text), skipped: /^ℹ skipped (\d+)$/m.exec(text) };
  if (node.passed || node.failed) return { passed: Number(node.passed?.[1] ?? 0), failed: Number(node.failed?.[1] ?? 0), skipped: Number(node.skipped?.[1] ?? 0) };
  // The last line that counts both or either: earlier lines are often per-file.
  const lines = text.split(/\r?\n/).filter((l) => /\b\d+\s+(passed|passing|failed|failing)\b/i.test(l));
  const line = lines.at(-1);
  if (!line) return null;
  const n = (re: RegExp) => Number(re.exec(line)?.[1] ?? 0);
  return { passed: n(/(\d+)\s+(?:passed|passing)\b/i), failed: n(/(\d+)\s+(?:failed|failing)\b/i), skipped: n(/(\d+)\s+(?:skipped|pending|todo)\b/i) };
}

export interface EditLines {
  path: string;
  old: string[];
  new: string[];
  /** Cut short: more lines than are shown. */
  more: number;
}

// Nothing is no lines, not one empty one: an edit with an empty old_string (a new file) took nothing out (+10 −0, not −1).
const linesOf = (s: unknown) => (typeof s === "string" && s !== "" ? s.replace(/\r\n/g, "\n").split("\n") : []);

/** An edit's lines out and in (or a written file's first lines), from its arguments, up to `max` in all. */
export function editLines(args: Record<string, unknown>, max = 40): EditLines | null {
  const path = [args.path, args.file_path, args.filePath].find((p): p is string => typeof p === "string") ?? "";
  const pairs: [string, string][] = [
    ["old_string", "new_string"],
    ["find", "content"],
    ["old", "new"],
    ["search", "replace"],
    ["oldText", "newText"],
  ];
  // Several changes in one call (Claude Code's MultiEdit, as `edits`): each one's lines, in turn, up to `max` in all.
  if (Array.isArray(args.edits)) {
    const out: string[] = [];
    const inn: string[] = [];
    let more = 0;
    for (const raw of args.edits) {
      if (!raw || typeof raw !== "object") continue;
      const one = editLines({ ...(raw as Record<string, unknown>), path }, Number.MAX_SAFE_INTEGER);
      if (!one) continue;
      for (const l of one.old) out.length + inn.length < max ? out.push(l) : more++;
      for (const l of one.new) out.length + inn.length < max ? inn.push(l) : more++;
    }
    if (out.length || inn.length || more) return { path, old: out, new: inn, more };
  }
  for (const [a, b] of pairs) {
    if (typeof args[a] !== "string" && typeof args[b] !== "string") continue;
    const o = linesOf(args[a]);
    const n = linesOf(args[b]);
    // The lines both keep, at either end, aren't the change.
    let head = 0;
    while (head < o.length && head < n.length && o[head] === n[head]) head++;
    let tail = 0;
    while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++;
    const out = o.slice(head, o.length - tail);
    const inn = n.slice(head, n.length - tail);
    const keepOld = Math.min(out.length, Math.ceil(max / 2));
    const keepNew = Math.min(inn.length, max - keepOld);
    // A whole file written (nothing taken out) whose content was cut for the log: `lines` says how many it really wrote.
    const cutOff = !o.length && typeof args.lines === "number" && args.lines > n.length ? args.lines - n.length : 0;
    return { path, old: out.slice(0, keepOld), new: inn.slice(0, keepNew), more: out.length - keepOld + (inn.length - keepNew) + cutOff };
  }
  for (const k of ["content", "text", "body"]) {
    if (typeof args[k] !== "string") continue;
    const all = linesOf(args[k]);
    // A Write's content is cut for the log; `lines` says how many it really wrote.
    const total = typeof args.lines === "number" && args.lines > all.length ? args.lines : all.length;
    return { path, old: [], new: all.slice(0, max), more: Math.max(0, total - Math.min(all.length, max)) };
  }
  return null;
}

/** How many lines an edit took out and put in, for its row: "+12 −3". */
export function editCounts(args: Record<string, unknown>): { added: number; removed: number } | null {
  const e = editLines(args, Number.MAX_SAFE_INTEGER);
  // What didn't fit in full (a long Write's lines beyond what the log kept) counts as added: it's all new lines.
  return e ? { added: e.new.length + (e.old.length ? 0 : e.more), removed: e.old.length } : null;
}

/** A search's hits by file, from grep and ripgrep's "path:line:text" (or "path:text"), most first. */
export function searchHits(output: string, max = 8): { files: { path: string; hits: number }[]; total: number } {
  const by = new Map<string, number>();
  let total = 0;
  for (const raw of strip(output).split(/\r?\n/)) {
    // A Windows path keeps its drive: "C:\\src\\a.ts:3:foo".
    const m = /^((?:[A-Za-z]:[\\/])?[^\s:][^:]*\.[\w]+):(\d+)?:?/.exec(raw);
    if (!m) continue;
    total++;
    by.set(m[1]!, (by.get(m[1]!) ?? 0) + 1);
  }
  const files = [...by].map(([path, hits]) => ({ path, hits })).sort((a, b) => b.hits - a.hits);
  return { files: files.slice(0, max), total };
}

/** The last lines of an output, which are where a command's answer is, and how many came before them. */
export function tailOf(output: string, n = 60): { lines: string[]; before: number } {
  const all = strip(output).replace(/\s+$/, "").split(/\r?\n/);
  return { lines: all.slice(-n), before: Math.max(0, all.length - n) };
}

/** "1.2s", "41s", "3m 05s". */
export function took(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
