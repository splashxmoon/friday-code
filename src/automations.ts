import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { describeSchedule, dueSlotSince, validateSchedule, type AgentSchedule } from "./agents.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineMode, type EngineTool } from "./types.js";
import { untrusted, UNTRUSTED_NOTE } from "./untrusted.js";
import { NO_UPDATE } from "./teammate-checkins.js";

/**
 * Automations: the coding tools working on their own (Arun, 2026-10-23: "get rid of the agents tab page and replace it with
 * automations, this will for the coding tools and stuff in sessions we need to make this very advanced but very easy to
 * understand and use").
 *
 * Each one reads as a sentence: when (a schedule, a webhook, an agent finishing in a session, or a press of Run now), who
 * (a coding tool, a team of them, or Friday's own agent, with a saved agent's instructions if picked), where (a folder on
 * its owner's computer, in its own copy), what it does (the words it is given, with what started it filled in), then (a
 * pull request, a word to its owner), and its limits (how many runs a day, what to do when the computer is off). A run is a
 * session of its own, owned by the automation's owner, started on their computer the way they would start it themselves.
 */

export type AutomationWhen =
  | { kind: "schedule"; schedule: AgentSchedule }
  | { kind: "webhook"; secret: string }
  /** An agent in this session finishing a run: "done", or stopping on an error. */
  | { kind: "session"; sessionId: string; sessionTitle: string; on: "finished" | "failed" }
  | { kind: "manual" }
  /** Something new on a GitHub repository, seen by this computer's `gh` looking every two minutes (githubNews). */
  | { kind: "github"; repo: string; event: GithubEvent; label: string };

/**
 * Agents that start themselves on events (Arun, 2026-11-27: "Agents that start themselves on events"). On someone's own
 * computer GitHub can't reach a webhook, so the computer looks instead, with the `gh` it is signed in with: a new issue (with a
 * label, if one is given), a pull request somebody else opened, or a check failing on the default branch. Nothing already there
 * when it was set up starts a run: the first look only notes what it sees.
 */
export type GithubEvent = "issue" | "pr" | "ci";
export const GITHUB_EVENTS: GithubEvent[] = ["issue", "pr", "ci"];
/** "owner/name", as gh and GitHub write it. */
export const isRepoName = (v: string): boolean => /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(v) && !v.includes("..");
/** How often a GitHub automation looks. */
export const GITHUB_LOOK_MS = 2 * 60_000;
/** At most this many runs from one look; the rest wait for the next (and the day's limit still holds). */
export const GITHUB_PER_LOOK = 3;

/** What one look at a repository saw (the runner's gh.watch). */
export interface GithubLook {
  /** Who this computer's gh is signed in as: their own pull requests aren't theirs to review. */
  me: string;
  defaultBranch: string;
  issues: { number: number; title: string; url: string; labels: string[]; author: string; body: string }[];
  prs: { number: number; title: string; url: string; author: string; draft: boolean; body: string }[];
  /** Workflow runs on the default branch, newest first. */
  runs: { id: number; name: string; conclusion: string; sha: string; url: string }[];
}

/** One thing that should start a run: its key (kept once seen), the run's trigger words and what it is told. */
export interface GithubNew {
  key: string;
  trigger: string;
  event: string;
}

/** Every key a look holds for this automation, new or not: the first look notes these and starts nothing. */
export function githubKeys(w: Extract<AutomationWhen, { kind: "github" }>, look: GithubLook): string[] {
  return githubItems(w, look).map((n) => n.key);
}

function githubItems(w: Extract<AutomationWhen, { kind: "github" }>, look: GithubLook): GithubNew[] {
  const body = (b: string) => (b.trim() ? `\n\n${b.trim().slice(0, 3000)}` : "");
  if (w.event === "issue")
    return look.issues
      .filter((i) => !w.label || i.labels.some((l) => l.toLowerCase() === w.label.toLowerCase()))
      .map((i) => ({ key: `issue:${i.number}`, trigger: `Issue #${i.number} in ${w.repo}`, event: `New issue #${i.number} in ${w.repo}${i.author ? ` by @${i.author}` : ""}: ${i.title}\n${i.url}${body(i.body)}` }));
  if (w.event === "pr")
    return look.prs
      .filter((p) => !p.draft && (!look.me || p.author.toLowerCase() !== look.me.toLowerCase()))
      .map((p) => ({ key: `pr:${p.number}`, trigger: `Pull request #${p.number} in ${w.repo}`, event: `New pull request #${p.number} in ${w.repo}${p.author ? ` by @${p.author}` : ""}: ${p.title}\n${p.url}${body(p.body)}` }));
  // One run per failing commit, however many of its workflows fail; a commit that is still running isn't failing yet.
  const seen = new Set<string>();
  return look.runs
    .filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out")
    .filter((r) => (seen.has(r.sha) ? false : (seen.add(r.sha), true)))
    .map((r) => ({ key: `ci:${r.sha}`, trigger: `${r.name} failed on ${look.defaultBranch || "the default branch"}`, event: `“${r.name}” failed on ${w.repo}'s ${look.defaultBranch || "default branch"} at commit ${r.sha.slice(0, 12)}.\n${r.url}\nSee its log with: gh run view ${r.id} --repo ${w.repo} --log-failed` }));
}

/** What in a look is new since the keys seen, oldest first (GitHub lists newest first), at most GITHUB_PER_LOOK of them. */
export function githubNews(w: Extract<AutomationWhen, { kind: "github" }>, look: GithubLook, seen: Set<string>): GithubNew[] {
  return githubItems(w, look).filter((n) => !seen.has(n.key)).reverse().slice(0, GITHUB_PER_LOOK);
}

export interface AutomationWho {
  /** A coding tool on the owner's computer, or Friday's own agent ("friday", Team only). */
  tool: EngineTool | "friday";
  /** More coding tools beside it, each in its own copy: the first one leads and they split the work on the board. */
  team: EngineTool[];
  mode: EngineMode;
  /** For Friday's own agent: its model ("" is Friday's). */
  model: string;
  /** A saved agent whose instructions it works by. */
  agentId: string;
}

export interface Automation {
  id: string;
  name: string;
  on: boolean;
  ownerId: string;
  ownerName: string;
  when: AutomationWhen;
  who: AutomationWho;
  /** A folder on the owner's computer; empty makes a new project folder for each run. */
  folder: string;
  /** In a copy of the folder of its own (a git worktree), so it never works over somebody's changes. */
  copy: boolean;
  does: string;
  then: { pr: boolean; notify: boolean };
  limits: { perDay: number; offline: "wait" | "skip" };
  created: number;
  /** When it was last saved (turned on or off included): a schedule's missed slot is caught up only from then (dueSlotSince). */
  updated?: number;
  /** From a saved agent's schedule, moved here when Agents became Automations. */
  from?: string;
  /**
   * Turned off because its owner is no longer in the workspace (offboard.ts): whose it was, who removed them (themself, when they
   * left), why and when. Kept until an admin hands it on or deletes it, or its owner, back in, turns it on again.
   */
  paused?: { person: { id: string; name: string }; by: { id: string; name: string }; why: "removed" | "left" | "deleted"; at: number };
}

/** `quiet`: it ran and had nothing new to say (NO_UPDATE): nobody is told, as OpenBot's quiet routine runs (Arun, 2026-11-11). */
export type RunStatus = "starting" | "running" | "done" | "failed" | "waiting" | "skipped" | "quiet";

export interface AutomationRun {
  id: string;
  at: number;
  /** What started it, in a few words: "every weekday at 09:00", "webhook", "Run now", "Codex finished in …". */
  trigger: string;
  status: RunStatus;
  sid?: string;
  invite?: string;
  /** Why it failed, was skipped or waits. */
  note?: string;
  ended?: number;
}

export interface AutomationInput {
  name?: unknown;
  on?: unknown;
  when?: unknown;
  who?: unknown;
  folder?: unknown;
  copy?: unknown;
  does?: unknown;
  then?: unknown;
  limits?: unknown;
}

const MODES: EngineMode[] = ["plan", "edits", "full"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isTool = (v: unknown): v is EngineTool => typeof v === "string" && (ENGINE_TOOLS as string[]).includes(v);

/** An automation as the page sent it, made safe: anything missing or wrong becomes the plain default. */
export function cleanAutomation(input: AutomationInput, prev?: Automation): Omit<Automation, "id" | "ownerId" | "ownerName" | "created"> {
  const w = (input.when ?? prev?.when ?? { kind: "manual" }) as Record<string, any>;
  const when: AutomationWhen =
    w.kind === "schedule"
      ? { kind: "schedule", schedule: validateSchedule(w.schedule) ?? { every: "daily", at: "09:00", days: [], tz: "UTC" } }
      : w.kind === "webhook"
        ? { kind: "webhook", secret: prev?.when.kind === "webhook" ? prev.when.secret : randomBytes(18).toString("base64url") }
        : w.kind === "session" && str(w.sessionId, 64)
          ? { kind: "session", sessionId: str(w.sessionId, 64), sessionTitle: str(w.sessionTitle, 120), on: w.on === "failed" ? "failed" : "finished" }
          : w.kind === "github"
            ? // Kept with a wrong repository rather than turned into Run now, so saving says what's wrong (app.ts) instead of quietly changing it.
              { kind: "github", repo: isRepoName(str(w.repo, 201).replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "")) ? str(w.repo, 201).replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "") : "", event: GITHUB_EVENTS.includes(w.event) ? w.event : "issue", label: w.event === "issue" || !GITHUB_EVENTS.includes(w.event) ? str(w.label, 50) : "" }
            : { kind: "manual" };
  const h = (input.who ?? prev?.who ?? {}) as Record<string, any>;
  const tool: AutomationWho["tool"] = h.tool === "friday" ? "friday" : isTool(h.tool) ? h.tool : "claude";
  const team = tool === "friday" ? [] : [...new Set((Array.isArray(h.team) ? h.team : []).filter(isTool))].filter((t) => t !== tool).slice(0, 4);
  const who: AutomationWho = { tool, team, mode: MODES.includes(h.mode) ? h.mode : "full", model: str(h.model, 80), agentId: str(h.agentId, 64) };
  const t = (input.then ?? prev?.then ?? {}) as Record<string, any>;
  const l = (input.limits ?? prev?.limits ?? {}) as Record<string, any>;
  const perDay = Number(l.perDay);
  return {
    name: str(input.name, 80) || prev?.name || "New automation",
    on: typeof input.on === "boolean" ? input.on : (prev?.on ?? true),
    when,
    who,
    folder: input.folder === undefined ? (prev?.folder ?? "") : str(input.folder, 600),
    copy: typeof input.copy === "boolean" ? input.copy : (prev?.copy ?? true),
    does: input.does === undefined ? (prev?.does ?? "") : str(input.does, 8000),
    then: { pr: t.pr === true, notify: t.notify !== false },
    limits: { perDay: Number.isFinite(perDay) && perDay > 0 ? Math.min(200, Math.max(1, Math.round(perDay))) : 10, offline: l.offline === "skip" ? "skip" : "wait" },
    ...(prev?.from ? { from: prev.from } : {}),
  };
}

/** "every weekday at 09:00 (Europe/London)", "when a webhook is called", …: the "when" of the sentence. */
export function describeWhen(w: AutomationWhen): string {
  if (w.kind === "schedule") return describeSchedule(w.schedule);
  if (w.kind === "webhook") return "when its webhook is called";
  if (w.kind === "github")
    return w.event === "pr"
      ? `when somebody opens a pull request in ${w.repo}`
      : w.event === "ci"
        ? `when a check fails on ${w.repo}'s default branch`
        : `when a new issue${w.label ? ` labelled “${w.label}”` : ""} is opened in ${w.repo}`;
  if (w.kind === "session") return `when an agent ${w.on === "failed" ? "stops on an error" : "finishes"} in “${w.sessionTitle || "a session"}”`;
  return "when you press Run now";
}

/** "Claude Code, with Codex and Cursor", "Friday": the "who" of the sentence. */
export function describeWho(h: AutomationWho): string {
  const name = h.tool === "friday" ? "Friday" : ENGINE_NAMES[h.tool];
  return h.team.length ? `${name} leading ${h.team.map((t) => ENGINE_NAMES[t]).join(" and ")}` : name;
}

/**
 * What started a run, filled into what it was told to do: {{event}} where it says, else after it. What a webhook posts, and
 * what an agent said in a watched session, are whoever could write them (a public repo's issue, a CI log, a page an agent
 * read), and the run starts in its owner's mode with nobody watching: fenced as material, never as orders (untrusted.ts).
 * Run now's words are the owner's own.
 */
export function promptFor(a: Automation, event: string): string {
  const base = a.does.trim() || "Do what you were set up to do.";
  const outside = !!event && (a.when.kind === "webhook" || a.when.kind === "session" || a.when.kind === "github");
  const said = outside ? untrusted("what started this run", event) : event;
  const told = base.includes("{{event}}") ? base.replaceAll("{{event}}", () => said) : event ? `${base}\n\nWhat started this run:\n${said}` : base;
  const parts = [
    `[Friday] This is an automation, “${a.name}”, running ${describeWhen(a.when)}. Nobody is watching it start: do the work, then finish with a short summary of what you did and anything a person should check.`,
    told,
    ...(outside ? [UNTRUSTED_NOTE] : []),
    // A run with nothing to show ends quietly: no message to its owner, "Nothing new" on the Automations page (Arun, 2026-11-11).
    `If there turns out to be nothing to do, or nothing new since its last run, reply with exactly ${NO_UPDATE} and nothing else: the run ends quietly and nobody is told.`,
  ];
  // Reviewing somebody's pull request: the review is for its owner to read and send. Commenting, approving or requesting changes
  // would speak as them (the Auto guardrail: never as the person).
  if (a.when.kind === "github" && a.when.event === "pr") parts.push("Write your review in your reply. Don't comment on the pull request, approve it or request changes: that would speak for the person, who reads your review and sends it themselves.");
  if (a.then.pr) parts.push("When you're done and the change works, commit it on a new branch and open a pull request with a short description (gh pr create). If there is nothing to change, say so instead.");
  if (a.who.team.length) parts.push("You lead the agents in this session: split the work onto the shared board so they start on it at once, do your own piece, then check it all fits.");
  return parts.join("\n\n");
}

const BASELINE = "·first-look";

/** Where automations are kept in Redis: per workspace, beside the workspace's other things. */
export class AutomationStore {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key = (ws: string) => `${this.prefix}automations:${ws}`;
  private runsKey = (ws: string, id: string) => `${this.prefix}automation-runs:${ws}:${id}`;
  /** Workspaces with at least one automation, for the clock. */
  readonly workspacesKey = () => `${this.prefix}automation-workspaces`;
  /** Automations watching a session, as "<workspace> <id>". */
  watchKey = (sid: string) => `${this.prefix}automation-watch:${sid}`;
  /** The run a session is, when an automation started it. */
  runOfKey = (sid: string) => `${this.prefix}automation-run:${sid}`;
  /** What a GitHub automation has seen (githubNews), and how its last look went. */
  seenKey = (ws: string, id: string) => `${this.prefix}automation-seen:${ws}:${id}`;
  lookKey = (ws: string, id: string) => `${this.prefix}automation-look:${ws}:${id}`;
  /** Runs waiting for their owner's computer, as "<workspace> <id> <run>", by when they began to wait. */
  readonly waitingKey = () => `${this.prefix}automation-waiting`;

  async list(ws: string): Promise<Automation[]> {
    const all = await this.redis.hvals(this.key(ws));
    return all.flatMap((r) => {
      try {
        return [JSON.parse(r) as Automation];
      } catch {
        return [];
      }
    }).sort((a, b) => a.created - b.created);
  }

  async get(ws: string, id: string): Promise<Automation | null> {
    const raw = await this.redis.hget(this.key(ws), id);
    return raw ? (JSON.parse(raw) as Automation) : null;
  }

  async put(ws: string, a: Automation, before?: Automation | null): Promise<void> {
    const m = this.redis.multi().hset(this.key(ws), a.id, JSON.stringify({ ...a, updated: Date.now() })).sadd(this.workspacesKey(), ws);
    if (before?.when.kind === "session" && (a.when.kind !== "session" || a.when.sessionId !== before.when.sessionId)) m.srem(this.watchKey(before.when.sessionId), `${ws} ${a.id}`);
    if (a.when.kind === "session") m.sadd(this.watchKey(a.when.sessionId), `${ws} ${a.id}`);
    // Watching something else on GitHub: what it saw before isn't what it watches now, so the next look starts afresh.
    const g = (x?: Automation | null) => (x?.when.kind === "github" ? `${x.when.repo} ${x.when.event} ${x.when.label}` : "");
    if (g(before) !== g(a)) m.del(this.seenKey(ws, a.id), this.lookKey(ws, a.id));
    await m.exec();
  }

  async remove(ws: string, id: string): Promise<void> {
    const a = await this.get(ws, id);
    const m = this.redis.multi().hdel(this.key(ws), id).del(this.runsKey(ws, id), this.seenKey(ws, id), this.lookKey(ws, id));
    if (a?.when.kind === "session") m.srem(this.watchKey(a.when.sessionId), `${ws} ${id}`);
    await m.exec();
  }

  async runs(ws: string, id: string, n = 30): Promise<AutomationRun[]> {
    return (await this.redis.lrange(this.runsKey(ws, id), 0, n - 1)).flatMap((r) => {
      try {
        return [JSON.parse(r) as AutomationRun];
      } catch {
        return [];
      }
    });
  }

  /** The keys a GitHub automation has seen; null before its first look. */
  async seen(ws: string, id: string): Promise<Set<string> | null> {
    const keys = await this.redis.smembers(this.seenKey(ws, id));
    // Marked by its first look that worked: a look that failed (gh signed out) must not make the next one start everything there.
    return keys.includes(BASELINE) ? new Set(keys) : null;
  }

  /** The first look that worked: everything there is noted, and nothing starts. */
  async baseline(ws: string, id: string, keys: string[]): Promise<void> {
    await this.addSeen(ws, id, [...keys, BASELINE]);
  }

  /** Keys seen, kept for 60 days (an issue closed long ago won't come back as new). */
  async addSeen(ws: string, id: string, keys: string[]): Promise<void> {
    const m = this.redis.multi();
    if (keys.length) m.sadd(this.seenKey(ws, id), ...keys);
    await m.expire(this.seenKey(ws, id), 60 * 24 * 3600).exec();
  }

  /** How its last look went: when, and what went wrong if anything ("" when it worked). */
  async looked(ws: string, id: string, note: string): Promise<void> {
    await this.redis.set(this.lookKey(ws, id), JSON.stringify({ at: Date.now(), note: note.slice(0, 300) }), "EX", 60 * 24 * 3600);
  }

  async lastLook(ws: string, id: string): Promise<{ at: number; note: string } | null> {
    const raw = await this.redis.get(this.lookKey(ws, id));
    try {
      return raw ? (JSON.parse(raw) as { at: number; note: string }) : null;
    } catch {
      return null;
    }
  }

  /** A run added at the front, the list kept to its last fifty. */
  async addRun(ws: string, id: string, run: AutomationRun): Promise<void> {
    await this.redis.multi().lpush(this.runsKey(ws, id), JSON.stringify(run)).ltrim(this.runsKey(ws, id), 0, 49).exec();
  }

  /** A run changed where it stands, by its id. */
  async updateRun(ws: string, id: string, runId: string, change: Partial<AutomationRun>): Promise<AutomationRun | null> {
    const key = this.runsKey(ws, id);
    const list = await this.redis.lrange(key, 0, 49);
    for (let i = 0; i < list.length; i++) {
      const r = JSON.parse(list[i]!) as AutomationRun;
      if (r.id !== runId) continue;
      const next = { ...r, ...change };
      await this.redis.lset(key, i, JSON.stringify(next));
      return next;
    }
    return null;
  }

  /** Counted against its runs a day, in the owner's day as the server keeps it (UTC). Over the limit: false, and not counted. */
  async countRun(ws: string, id: string, perDay: number, now = new Date()): Promise<boolean> {
    const key = `${this.prefix}automation-count:${ws}:${id}:${now.toISOString().slice(0, 10)}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 2 * 24 * 3600);
    if (n > perDay) {
      await this.redis.decr(key);
      return false;
    }
    return true;
  }

  async runsToday(ws: string, id: string, now = new Date()): Promise<number> {
    return Number(await this.redis.get(`${this.prefix}automation-count:${ws}:${id}:${now.toISOString().slice(0, 10)}`)) || 0;
  }

  /** The schedule slot claimed once across every node: a minute checked twice, or by two servers, still runs once. */
  async claimSlot(ws: string, id: string, slot: string): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}automation-fired:${ws}:${id}:${slot}`, "1", "EX", 2 * 24 * 3600, "NX")) === "OK";
  }
}

/** Whether a scheduled automation is due, in the minute `now` is in or one missed since it was saved (dueSlotSince), as its slot's name. */
export const dueAutomation = (a: Automation, now: Date): string | null => (a.on && a.when.kind === "schedule" ? dueSlotSince(a.when.schedule, now, a.updated ?? a.created) : null);

/** How long a run waits for its owner's computer before it is skipped. */
export const WAIT_FOR_COMPUTER_MS = 12 * 60 * 60_000;
