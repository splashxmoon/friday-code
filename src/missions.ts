import type { Goal, Manager, ManagerTask } from "./managers.js";

/**
 * Missions: a Captain owns an outcome for days (Arun, 2026-11-27: "missions"; spec 10 B, "a crew mate owns a goal for days").
 *
 * A mission is one of a Run Captain's goals with more to it: what "done" means in the person's words, how many threads may run at
 * once (each in its own copy of the project), a budget, and whether finished work becomes pull requests. The Captain plans it into
 * stages ("Queue:" tasks run alongside each other; an "After:" task starts a new stage that waits for everything before it), runs
 * them, checks each the way it checks any thread, and when the work runs out it judges the done condition: met, and the mission is
 * done; not met, and it plans what's left, up to MISSION_ROUNDS times, then brings it to the person. A daily report says where it
 * stands. It never merges: shipping stays the person's (the Auto guardrail), a pull request only when they allowed it.
 *
 * Pure: the rules and the words. managers-run.ts runs them.
 */

export interface Mission {
  /** What done means, in the person's words: what the judge holds the work to. */
  done: string;
  /** Threads it may run at once, each in its own copy. */
  parallel: number;
  /** Finished, checked work becomes a pull request (the person allowed it); otherwise it waits on Review & ship. */
  prs: boolean;
  /** A spend cap across its threads in dollars (spend.ts prices); 0 is none. */
  budgetUsd: number;
  /** Rounds of "is it done? no, here's what's left" so far. */
  rounds: number;
  /** About what its threads have spent, in dollars, as last counted. */
  spent: number;
  /** Paused by the person, or by itself (its budget): nothing new starts. */
  paused?: { why: string; at: number; by: "you" | "budget" };
  /** Its daily reports, newest first. */
  reports: { day: string; at: number; text: string }[];
  /** Its last judgement of the done condition. */
  verdict?: { met: boolean; why: string; at: number };
  /** When the Captain was last asked to plan or judge it, and which: a turn lost to a restart is asked again. */
  asked?: { kind: "plan" | "judge"; at: number };
}

export const MISSION_ROUNDS = 6;
export const PARALLEL_MAX = 4;
export const PARALLEL_DEFAULT = 2;
export const REPORTS_KEEP = 14;
/** A plan or judgement asked for and not heard in this long (a restart, a lost turn) is asked again. */
export const ASK_AGAIN_MS = 15 * 60_000;

const words = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A mission as the page sent it, made safe, or why not. */
export function cleanMission(input: Record<string, unknown>): { ok: true; ask: string; title: string; mission: Mission } | { ok: false; error: string } {
  const ask = typeof input.ask === "string" ? input.ask.replace(/\r/g, "").trim().slice(0, 4000) : "";
  if (!ask) return { ok: false, error: "Say what the mission is." };
  const done = words(input.done, 600);
  if (!done) return { ok: false, error: "Say what done looks like, so it knows when to stop." };
  const n = Math.round(Number(input.parallel));
  const budget = Number(input.budgetUsd);
  return {
    ok: true,
    ask,
    title: words(input.title, 80) || words(ask.split("\n")[0], 80),
    mission: { done, parallel: Number.isFinite(n) && n >= 1 ? Math.min(PARALLEL_MAX, n) : PARALLEL_DEFAULT, prs: input.prs === true, budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(10_000, Math.round(budget * 100) / 100) : 0, rounds: 0, spent: 0, reports: [] },
  };
}

/** The mission a queued task belongs to, if any. */
export const missionOf = (m: Pick<Manager, "goals">, t: Pick<ManagerTask, "goal">): Goal | null => {
  const g = t.goal ? m.goals?.find((x) => x.id === t.goal) : undefined;
  return g?.mission ? g : null;
};

/** Live: not done, given up or stuck for good. */
export const missionLive = (g: Goal): boolean => !!g.mission && (g.status === "working" || g.status === "checking" || g.status === "ready");

/**
 * The queued tasks of its missions that may start now: within each mission's threads at once, a stage only once every earlier
 * stage's tasks have started and their threads are ready or shipped. On Run, on, out of quiet hours (the caller says), not paused.
 */
export function missionStarts(m: Manager, quiet: boolean): ManagerTask[] {
  if (!m.on || m.level !== "run" || quiet) return [];
  const out: ManagerTask[] = [];
  for (const g of m.goals ?? []) {
    if (!g.mission || g.status !== "working" || g.mission.paused) continue;
    const mine = m.queue.filter((q) => q.goal === g.id);
    if (!mine.length) continue;
    const free = g.mission.parallel - g.threads.filter((t) => t.state === "running").length;
    if (free <= 0) continue;
    const stage = Math.min(...mine.map((q) => q.stage ?? 0));
    // An earlier stage still going (running, stuck): this one waits for it.
    if (g.threads.some((t) => (t.stage ?? 0) < stage && (t.state === "running" || t.state === "stuck"))) continue;
    for (const q of mine.filter((x) => (x.stage ?? 0) === stage).slice(0, free)) out.push(q);
  }
  return out;
}

/** Plan lines read from a reply in order: "Queue:" joins the current stage, "After:" starts the next. */
export function planLines(text: string): { text: string; after: boolean }[] {
  return text
    .split("\n")
    // Bold taken off before a bullet: "**Queue:** x" is a task, not a bullet "*" and a stray "*Queue:".
    .map((l) => l.replace(/\*\*/g, "").trim().replace(/^[-*]\s*/, ""))
    .flatMap((l) => {
      const q = /^queue:\s*(.+)$/i.exec(l);
      if (q) return [{ text: q[1]!.slice(0, 2000), after: false }];
      const a = /^after:\s*(.+)$/i.exec(l);
      return a ? [{ text: a[1]!.slice(0, 2000), after: true }] : [];
    })
    .filter((x) => x.text.trim());
}

/** Its judgement of the done condition from a reply: "Done: yes — why" / "Done: no — why"; null when it didn't say. */
export function doneLine(text: string): { met: boolean; why: string } | null {
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\*\*/g, "").trim().replace(/^[-*]\s*/, "");
    const m = /^done:\s*(yes|no)\b[\s:—–,.-]*(.*)$/i.exec(l);
    if (m) return { met: m[1]!.toLowerCase() === "yes", why: m[2]!.trim().slice(0, 400) };
  }
  return null;
}

/** Stages for a plan's lines, after the mission's existing ones: each "After:" starts the next. */
export function staged(lines: { text: string; after: boolean }[], from: number): { text: string; stage: number }[] {
  let stage = from;
  return lines.map((l, i) => {
    if (l.after && i > 0) stage++;
    return { text: l.text, stage };
  });
}

/** The stage new work for a mission starts at: after everything it has queued or run. */
export function nextStage(m: Pick<Manager, "queue">, g: Goal, fresh: boolean): number {
  const stages = [...g.threads.map((t) => t.stage ?? 0), ...m.queue.filter((q) => q.goal === g.id).map((q) => q.stage ?? 0)];
  return stages.length ? Math.max(...stages) + (fresh ? 1 : 0) : 0;
}

const howMany = (n: number) => (n === 1 ? "one thread" : `${n} threads`);

/** What the Captain is told when a mission starts: plan it into stages. */
export function missionPlanText(project: string, g: Goal): string {
  const ms = g.mission!;
  return [
    `[Captain message] A new mission for "${project}", for you to own until it's done: "${g.title}".`,
    `What the person asked:\n${g.ask}`,
    `Done when: ${ms.done}`,
    `You may run ${howMany(ms.parallel)} at once, each in its own copy of the project.${ms.prs ? " Each finished, checked piece becomes a pull request." : " Finished work waits for the person to ship."}`,
    `Plan it: reply with a line starting "Reply:" saying in a sentence how you'll go about it, then one "Queue: <task>" line per thread-sized task that can run alongside the others, and an "After: <task>" line for a task that must wait until everything above it is ready (it starts a new stage; "Queue:" lines after it join that stage). Each task one clear instruction a coding agent can act on alone, naming the files or area when you know them. Don't over-split: a big task is split into parts by Friday. Read the code or the sessions first if you need to. If the person must decide something before any work can start, add a "For you:" line with the question and your recommended answer.`,
  ].join("\n\n");
}

/** What the Captain is told when a mission's work runs out: is it done? */
export function missionCheckText(project: string, g: Goal, ready: string[]): string {
  const ms = g.mission!;
  const threads = g.threads.map((t) => `- ${t.task.slice(0, 160)}: ${t.state}${t.state === "shipped" ? "" : t.state === "ready" ? " (checked, waiting to ship)" : ""}`).join("\n") || "- nothing ran";
  return [
    `[Captain message] Mission check for "${g.title}" in "${project}" (round ${ms.rounds + 1} of ${MISSION_ROUNDS}). Its work has run out: decide whether it's done.`,
    `What the person asked:\n${g.ask}`,
    `Done when: ${ms.done}`,
    `What ran:\n${threads}`,
    ready.length ? `Ready to ship:\n${ready.map((r) => `- ${r}`).join("\n")}` : "",
    `Look at the threads (read_session) or the code to be sure, then reply with "Done: yes — <why, in a sentence>" if the done condition is met by the work, shipped or ready. If not, reply "Done: no — <what's missing>" followed by "Queue:" and "After:" lines for only what's still needed. If only the person can unblock it, add a "For you:" line with the question and your recommended answer.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What a mission thread is told once its work passed its check, when the person allowed pull requests. */
export const MISSION_PR_TEXT =
  "[Friday] Your work passed its check. This is part of a mission whose owner allowed pull requests: commit it on a new branch named for the change, push it, and open a pull request with a short description of what changed and how you checked it (gh pr create). Don't merge it: the person ships it.";

/** A mission's standing in a line: "2 of 5 ready · 1 running · 3 queued · $4.10 of $20". */
export function missionLine(m: Pick<Manager, "queue">, g: Goal): string {
  const ms = g.mission;
  const n = (s: Goal["threads"][number]["state"]) => g.threads.filter((t) => t.state === s).length;
  const queued = m.queue.filter((q) => q.goal === g.id).length;
  const total = g.threads.length + queued;
  const money = ms && (ms.budgetUsd || ms.spent >= 0.01) ? `$${ms.spent.toFixed(2)}${ms.budgetUsd ? ` of $${ms.budgetUsd}` : ""}` : "";
  return [total ? `${n("ready") + n("shipped")} of ${total} ready` : "planning", n("running") && `${n("running")} running`, queued && `${queued} queued`, n("stuck") && `${n("stuck")} stuck`, money].filter(Boolean).join(" · ");
}

/** Its report for a day: what moved, where it stands, and what's next. Read from its record, no model. */
export function missionReport(m: Pick<Manager, "queue">, g: Goal, day: string, now: number): { day: string; at: number; text: string } {
  const ms = g.mission!;
  const state =
    g.status === "done"
      ? `Done${ms.verdict?.why ? `: ${ms.verdict.why}` : ""}.`
      : ms.paused
        ? `Paused: ${ms.paused.why}.`
        : g.status === "stuck"
          ? "Stuck: it needs you."
          : g.status === "checking"
            ? "Checking whether it's done."
            : "Working.";
  return { day, at: now, text: `${state} ${missionLine(m, g)}.` };
}

/** Whether today's report is due: once a day, from 8 in the morning, while the mission is live. */
export const reportDue = (g: Goal, day: string, hour: number): boolean => missionLive(g) && hour >= 8 && g.mission!.reports[0]?.day !== day;

/** Over its budget: the pause it takes, or null. */
export function overBudget(ms: Mission, now: number): Mission["paused"] | null {
  if (!ms.budgetUsd || ms.paused || ms.spent < ms.budgetUsd) return null;
  return { why: `it reached its $${ms.budgetUsd} budget ($${ms.spent.toFixed(2)} spent)`, at: now, by: "budget" };
}
