import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, ClockIcon, PlusIcon } from "lucide-react";
import { ENGINE_NAMES } from "../types.js";
import type { Attention } from "../attention.js";
import type { TeamBrief } from "../types.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import type { Identity, RecentSession } from "./storage.js";
import { readSince } from "./team-api.js";
import type { TeammateView } from "../teammates.js";
import { Face, MateRing, mateStatus, modelLabel, newTeammate, openRoom, openTeammate, ownOf, RoomDialog, roomNow, roomsOf, RoomFaces, useTeam, type RoomView } from "./Teammates.js";
import { CLASS_LABEL, headlineClass } from "../command-class.js";
import { Shine } from "./shine.js";
import { Badge, Button, Checkbox } from "@/components/affect";
import { plainLine } from "./team-room.js";
import { withCode } from "./Attention.js";
import { freeLine, roleWord } from "./team-status.js";
import { plainRisk } from "../plain-risk.js";
import { mateItems } from "./mate-menu.js";
import { MenuButton, useConfirm } from "./ui.js";
import { useNow } from "./presence.js";
import "./agents-page.css";

/**
 * The Agents page: the Crew's home once it has teammates (Arun, 2026-11-11, option 2A of the Crew overhaul, after OpenBot and
 * Oh My Hermes). What needs you first, answered right there and stepped through with ⌘J; then the crew, one row each with its
 * role and what it is doing now; the rooms; and what finished today. It replaces opening straight into the Crew room.
 */
export default function AgentsPage({ identity, onOpen, needs = [] }: { identity: Identity; onOpen: (r: RecentSession) => void; /** What waits on you (Attention.tsx), the crew's own shown here. */ needs?: Attention[] }) {
  const t = useTeam(identity);
  const [ask, confirmUI] = useConfirm();
  // Each row's "2m" moves as time does, not only when the crew's reading changes.
  const now = useNow(30_000);
  const [rooming, setRooming] = useState(false);
  const [brief, setBrief] = useState<TeamBrief | null>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  /** "Always allow" on the card's go-ahead, as the thread's permission card has it; cleared when the card moves to another wait. */
  const [always, setAlways] = useState(false);
  const mates = t ? ownOf(t) : [];
  // The crew's own waits: its sessions (the Crew room and its rooms).
  const sids = useMemo(() => new Set(t ? [t.sid, ...(t.rooms ?? []).map((r) => r.sid)] : []), [t]);
  const waits = needs.filter((n) => sids.has(n.sid) && (n.kind === "approval" || n.kind === "question" || n.kind === "ask" || n.kind === "stopped"));
  const one = waits[Math.min(at, Math.max(0, waits.length - 1))];
  const waitName = one ? (mates.find((m) => m.lane === one.lane)?.name ?? one.agent ?? "A crew mate") : "";
  const plain = one?.approval && one.items?.length ? plainRisk(one.items) : null;
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    void readSince(identity, start.getTime()).then((b) => b && setBrief(b));
  }, [identity, t?.news]);
  // A tick is for the go-ahead it was given on: another one (stepped to, or the next after an answer) starts unticked.
  useEffect(() => setAlways(false), [one?.approval]);
  // ⌘J steps to the next thing that needs you, as Oh My Hermes does.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j" || waits.length < 2) return;
      e.preventDefault();
      setAt((i) => (i + 1) % waits.length);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [waits.length]);
  if (!t) return null;

  const mateOf = (lane?: string): TeammateView | undefined => mates.find((m) => m.lane === lane) ?? mates.find((m) => lane?.endsWith(m.lane));
  const inviteOf = (sid: string) => (sid === t.sid ? t.invite : (t.rooms ?? []).find((r) => r.sid === sid)?.invite ?? "");
  const answer = async (w: Attention, approve: boolean, task = false) => {
    if (!w.approval) return;
    // Always allow ticked: its commands go on the session's allow list first, then it runs (app.ts /answer, command-allow.ts).
    const keep = approve && !task && always && !!w.always?.length;
    setBusy(approve ? "yes" : "no");
    setNote("");
    try {
      await api(identity, `/api/sessions/${w.sid}/answer?invite=${encodeURIComponent(inviteOf(w.sid))}`, { method: "POST", body: JSON.stringify({ lane: w.lane, id: w.approval, approve, ...(task ? { task: true } : {}), ...(keep ? { always: true } : {}) }), headers: { "Content-Type": "application/json" } });
    } catch (e) {
      setNote((e as Error).message || "That didn't go through. Open it and answer there.");
    } finally {
      setBusy("");
    }
  };
  const openWait = (w: Attention) => {
    const m = mateOf(w.lane);
    if (w.sid === t.sid) openTeammate(t, m?.lane ?? null, onOpen);
    else onOpen({ sid: w.sid, invite: inviteOf(w.sid), title: w.title, role: "owner", openedAt: Date.now() });
  };
  const order = [...mates].sort((a, b) => rank(a) - rank(b) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const done = (brief?.done ?? []).slice(-6).reverse();

  // What a go-ahead's commands are, as the thread's permission card chips it: red deletes, amber the rest to look at first.
  const risk = one?.approval && one.items?.length ? commandRisk(one.items) : null;
  const step = () => setAt((i) => (i + 1) % waits.length);
  const allowSaid = one?.always?.map((a) => (a.endsWith("*") ? `“${a.slice(0, -1).trim()} …”` : `“${a}”`)).join(", ") ?? "";

  return (
    <div className="ap ap-page">
      <header className="ap-head">
        <h1>Agents</h1>
        <span className="ap-count">{mates.length} on your crew</span>
        <span className="ap-head-acts">
          {/* No Away here (Arun, 2026-11-15: "get rid of the away until morning stuff on this page"): it is a room's, in its profile. */}
          <Button variant="secondary" icon={<PlusIcon />} onClick={newTeammate}>
            New agent
          </Button>
        </span>
      </header>

      <div className="ap-body">
        {/* What needs you, drawn as the kit's Approval Card (radius 14, raised): who asks, what in plain words and its command with
            its risk as a chip; under a hairline, Open and the step through on the left, the answers on the right with the main one
            last. With the keyboard on it, Esc is Deny and ⌘↵ Allow once, as on the thread's card. */}
        {one && (
          <section
            className="ap-needs"
            aria-label="Needs you"
            aria-live="polite"
            tabIndex={one.approval ? 0 : undefined}
            onKeyDown={(e) => {
              if (!one.approval || busy || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
              if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), void answer(one, false));
              else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), e.stopPropagation(), void answer(one, true));
            }}
          >
            <div className="ap-needs-head">
              <Face seed={mateOf(one.lane)?.look ?? mateOf(one.lane)?.name ?? one.agent ?? "?"} size={32} status="waiting" />
              <div className="ap-needs-text">
                <div className="ap-needs-line">
                  {/* Its name once, then what it wants in plain words, as its card says it (plain-risk.ts): "wants to publish a package to npm". */}
                  <b>{waitName}</b> {plain ? `wants to ${plain.does}` : withCode(one.text.startsWith(`${waitName} `) ? one.text.slice(waitName.length + 1) : one.text)}
                </div>
                {plain ? (
                  <div className="ap-needs-why">
                    {withCode(`\`${one.items![0]}\`${one.items!.length > 1 ? ` and ${one.items!.length - 1} more` : ""}`)}
                    {plain.risk ? ` · ${plain.risk}` : ""}
                  </div>
                ) : (
                  one.detail && <div className="ap-needs-why">{withCode(one.detail)}</div>
                )}
                {note && <div className="ap-needs-why ap-err">{note}</div>}
              </div>
              {risk ? <Badge tone={risk.tone === "bad" ? "danger" : risk.tone === "warn" ? "warning" : "neutral"}>{risk.label}</Badge> : <Badge tone="warning">Needs you</Badge>}
            </div>
            <div className="ap-needs-foot">
              <Button variant="ghost" onClick={() => openWait(one)}>
                Open
              </Button>
              {one.approval && !!one.always?.length && (
                <Checkbox className="ap-needs-always" label="Always allow" checked={always} disabled={!!busy} title={`From now on run ${allowSaid} without asking`} onChange={(e) => setAlways(e.currentTarget.checked)} />
              )}
              {waits.length > 1 && (
                <button type="button" className="ap-needs-step" onClick={step} aria-label={`Next: ${Math.min(at, waits.length - 1) + 1} of ${waits.length}`}>
                  {Math.min(at, waits.length - 1) + 1} of {waits.length} <kbd>⌘J</kbd>
                </button>
              )}
              <span className="ap-needs-acts">
                {one.approval && (
                  <>
                    <Button variant="ghost" className="ap-keyed" disabled={!!busy} aria-keyshortcuts="Escape" iconRight={<kbd>Esc</kbd>} onClick={() => void answer(one, false)}>
                      Deny
                    </Button>
                    {/* As the chat's card offers it: commands like this one, without asking, until the task is done. */}
                    {/* Only where it does what it says (taskAllowApplies): the host of its computer, in a session they own. */}
                    {one.forTask && (
                      <Button variant="secondary" disabled={!!busy} onClick={() => void answer(one, true, true)} title="Let it run commands like this without asking until it next stops">
                        Allow for this task
                      </Button>
                    )}
                    <Button className="ap-keyed" disabled={!!busy} aria-keyshortcuts="Meta+Enter Control+Enter" iconRight={<kbd>{runKey()}</kbd>} title={always && one.always?.length ? "Allow it, and from now on without asking" : undefined} onClick={() => void answer(one, true)}>
                      Allow once
                    </Button>
                  </>
                )}
                {!one.approval && (
                  <Button onClick={() => openWait(one)}>
                    {/* What the press does, by what waits: a stopped run is looked at (its chat offers Retry), a question answered. */}
                    {one.kind === "stopped" ? "See why" : "Answer"}
                  </Button>
                )}
              </span>
            </div>
          </section>
        )}

        {/* The crew as the kit's Agent Fleet cards: its face, name and ring, its role and what it runs on, a chip only when it
            needs you or stopped; what it is doing now, shining while it works; how long ago, Message and its menu. */}
        <section aria-labelledby="ap-crew">
          <h2 id="ap-crew" className="ap-label">
            Your crew
          </h2>
          <ul className="ap-list">
            {order.map((m) => {
              const s = mateStatus(m);
              // "Needs you: …" said once, by its chip, the line keeping what it waits on.
              const said = freeLine(m, s);
              const line = s.state === "waiting" ? said.replace(/^needs you:\s*/i, "") : said;
              const chip = roleWord(m.role ?? "");
              // What it runs on, as a coding tool and its model (Arun, 2026-11-03: "coding agent | model (reasoning level)").
              const runs = m.tool === "friday" ? modelLabel(m.tool, m.model) : `${ENGINE_NAMES[m.tool] ?? m.tool}${m.model ? ` · ${modelLabel(m.tool, m.model)}` : ""}`;
              // At work, the approved mock's blue Working chip with its turning ring (as the Captain screens' chip), beside the face's
              // ring and the shining line; needing you, stopped or out of usage, its own chip; free, none.
              const flag = s.state === "working" ? { tone: "info" as const, word: "Working" } : s.state === "waiting" ? { tone: "warning" as const, word: "Needs you" } : s.state === "stopped" ? { tone: "danger" as const, word: "Stopped" } : s.state === "limited" ? { tone: "warning" as const, word: "Out of usage" } : null;
              return (
                <li key={m.id} className="ap-row" data-state={s.state}>
                  <button type="button" className="ap-row-main" onClick={() => openTeammate(t, m.lane, onOpen)}>
                    <Face seed={m.look ?? m.name} size={28} status={m.status} lead={t.lead === m.lane} />
                    <span className="ap-row-text">
                      <span className="ap-row-name">
                        <b>{m.name}</b>
                        <MateRing status={m.status} />
                      </span>
                      <span className="ap-row-sub">{[chip, runs].filter(Boolean).join(" · ")}</span>
                    </span>
                    {flag && (
                      <Badge tone={flag.tone} className="ap-row-flag" icon={flag.tone === "info" ? <span className="ap-ring" /> : flag.tone === "warning" ? <ClockIcon size={12} /> : <CircleAlertIcon size={12} />}>
                        {flag.word}
                      </Badge>
                    )}
                  </button>
                  <Shine on={s.state === "working"} className={`ap-row-line s-${s.state}`}>
                    {line}
                  </Shine>
                  <span className="ap-row-foot">
                    {m.lastAt ? <span className="ap-when">{ago(m.lastAt, now)}</span> : null}
                    <Button size="sm" variant="ghost" className="ap-row-msg" onClick={() => openTeammate(t, m.lane, onOpen)}>
                      Message
                    </Button>
                    <MenuButton className="ap-row-more" label={`More for ${m.name}`} items={() => mateItems({ identity, team: t, mate: m, ask })} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="ap-rooms">
          <h2 id="ap-rooms" className="ap-label">
            Rooms
          </h2>
          <div className="ap-rooms">
            {roomsOf(t).map((r: RoomView) => {
              // Who is at work in it, or that it needs you, as the sidebar's row says (Teammates.tsx roomNow).
              const now = roomNow(r, mates);
              return (
                <button key={r.id} type="button" className="ap-room" data-tone={now.state?.tone} onClick={() => openRoom(r, onOpen)}>
                  <RoomFaces seeds={now.seeds.slice(0, 3)} states={now.states.slice(0, 3)} size={22} />
                  <span className="ap-room-text">
                    <b>
                      {r.name}
                      {now.ring && <MateRing status={now.ring} title={now.state?.word} />}
                    </b>
                    <span>{plainLine(now.line)}</span>
                  </span>
                </button>
              );
            })}
            <button type="button" className="ap-room ap-room-new" onClick={() => setRooming(true)}>
              <Icon name="plus" size={16} /> New room for a project
            </button>
          </div>
        </section>

        {/* What finished today, as the kit's decided rows (Approval Gates): 32 tall, a check in a soft circle, the title, who and how much. */}
        {done.length > 0 && (
          <section aria-labelledby="ap-done">
            <h2 id="ap-done" className="ap-label">
              Finished today
            </h2>
            <ul className="ap-done">
              {done.map((d, i) => {
                const m = mateOf(d.lane);
                return (
                  <li key={`${d.lane}-${d.seq ?? i}`}>
                    <span className="ap-done-check" aria-hidden="true">
                      <Icon name="check" size={10} />
                    </span>
                    <span className="ap-done-title">{d.title}</span>
                    <span className="ap-done-meta">
                      <Face seed={m?.look ?? d.name} size={16} />
                      {d.name}
                      {d.files?.length ? ` · ${d.files.length} file${d.files.length === 1 ? "" : "s"}` : ""}
                      {d.pr ? " · a pull request" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {rooming && <RoomDialog identity={identity} team={t} editing={null} onClose={() => setRooming(false)} onMade={(r) => openRoom(r, onOpen)} />}
      {confirmUI}
    </div>
  );
}

/** The riskiest kind among a go-ahead's commands, as the thread's permission card chips it (Activity.tsx riskOf). */
const RISK_ORDER = ["destructive", "deploy", "publish", "other", "install", "git", "build", "checks", "read"] as const;
function commandRisk(items: readonly string[]): { label: string; tone: "bad" | "warn" | "" } | null {
  const kinds = new Set(items.map((i) => headlineClass(i)));
  const k = RISK_ORDER.find((x) => kinds.has(x));
  if (!k) return null;
  return { label: CLASS_LABEL[k].chip ?? CLASS_LABEL[k].label, tone: k === "destructive" ? "bad" : CLASS_LABEL[k].careful || k === "install" ? "warn" : "" };
}
const runKey = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘↵" : "Ctrl ↵");

/** Who needs you first, then who works, then the rest. */
const rank = (m: TeammateView) => (m.status === "waiting" ? 0 : m.status === "stopped" ? 1 : m.status === "working" ? 2 : 3);

/** How long ago, short: "now", "2m", "3h", "Tue". */
function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString([], { weekday: "short" });
}
