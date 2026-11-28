import type { SessionEvent } from "../types.js";
import { MAIN_LANE } from "../types.js";

/**
 * Compacting an own model's conversation instead of forgetting it (HANDOFF-local-models-2026-11-28, phase 2; the mock's 1A and 1B).
 *
 * Before a turn whose history would pass 75% of the model's window, the same model writes a summary of the older turns, and from
 * then on the summary is sent in their place: the opening instruction, the summary, then the last few turns whole. The turns
 * themselves stay in the log (the thread shows them as before); only what buildContext sends changes. Undo (context.restored)
 * sends the full history again, which only helps once the window is bigger.
 */

/** How full the window may get before a turn compacts first (Settings › Your models, "Compact at 75%"). */
export const COMPACT_AT = 0.75;
/** The newest turns kept whole: what the model is in the middle of. */
export const KEEP_TURNS = 4;

/** The compaction in force on a lane: the newest one with a summary, unless it was undone. */
export function activeCompaction(events: SessionEvent[], lane: string): { seq: number; upTo: number; summary: string } | null {
  const undone = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "context.restored") undone.add(e.body.of);
    else if (e.body.type === "context.compacted" && e.body.summary && e.body.upTo) {
      if (undone.has(e.seq)) return null;
      return { seq: e.seq, upTo: e.body.upTo, summary: e.body.summary };
    }
  }
  return null;
}

/**
 * Where a compaction would cut: just before the agent turn that starts the last `keep` kept whole, so no tool call is left
 * without its result. Null when there's too little to compact (fewer older turns than are worth a summary), or nothing new
 * since the compaction in force.
 */
export function cutFor(events: SessionEvent[], lane: string, keep = KEEP_TURNS): { upTo: number; turns: number } | null {
  const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
  const turns = mine.filter((e) => e.body.type === "agent.message" && !e.body.interrupted);
  const since = activeCompaction(events, lane)?.upTo ?? 0;
  if (turns.length <= keep) return null;
  const first = turns[turns.length - keep]!;
  const upTo = first.seq - 1;
  const older = turns.filter((t) => t.seq > since && t.seq <= upTo).length;
  if (older < 2) return null;
  return { upTo, turns: older + (since ? 1 : 0) };
}

/** What the model is asked to write: the five sections the summary card shows (1B), short, from what the turns say. */
export const SUMMARY_SYSTEM = [
  "You compact a coding agent's conversation so it can keep going inside its model's context window.",
  "Write a summary of the conversation below for the agent itself to carry on from. Use exactly these sections, as Markdown headings, in this order, and leave out any that would be empty:",
  "## Goal",
  "What the person wants, in their terms, in one or two lines.",
  "## Done",
  "What has been done, as short bullets: results, numbers, what was found, where it was saved.",
  "## Next",
  "What is left, as short bullets, in order.",
  "## Files",
  "The files and folders read or changed, comma-separated, with one word on each where it helps.",
  "## Decisions",
  "Choices made and why, and anything the person asked for or ruled out.",
  "Keep facts exact (paths, names, numbers, commands). No preamble, no closing line. At most about 600 words.",
].join("\n");

/** The summary as it is sent in place of the turns it covers. */
export const summaryNote = (summary: string, turns: number) =>
  `[session] ${turns} earlier turn${turns === 1 ? " was" : "s were"} compacted into this summary to stay inside the model's window. They happened; this is what they came to. Carry on from it, and re-read a file if you need its exact text.\n\n${summary.trim()}`;

/** The sections of a summary, for the card that shows it (1B): heading and its lines. */
export function summarySections(summary: string): { title: string; lines: string[] }[] {
  const out: { title: string; lines: string[] }[] = [];
  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,4}\s*(.+)$/.exec(line);
    if (h) out.push({ title: h[1]!.replace(/[:*]+$/, "").trim(), lines: [] });
    else if (line && out.length) out[out.length - 1]!.lines.push(line.replace(/^[-*•]\s*/, ""));
    else if (line) out.push({ title: "Summary", lines: [line] });
  }
  return out.filter((s) => s.lines.length);
}
