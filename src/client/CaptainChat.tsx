/**
 * The Captain page's left column: a conversation with the lead (Arun, 2026-11-27, picking "Chat with the lead"; plan in
 * docs/plans/captain-v2.md, Contract v1). You say what should get done; it answers with a plan card (each task and the agent that
 * takes it) that you start or edit, then posts a short line as each of its agents starts, finishes, fails or needs you. What needs
 * you sits on top. The box at the foot, with how far it may go on its own.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpIcon } from "lucide-react";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import type { ChatLine } from "../managers.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool } from "../types.js";
import { api as call } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon, type IconName } from "./icons.js";
import { Popover } from "./components/affect/popover.js";
import { askShort, clockOf, forYouOf, ManagerFace, type ManagersApi, type ManagerView } from "./Managers.js";
import { md } from "./markdown.js";
import { Shine } from "./shine.js";
import { LiveClock } from "./presence.js";
import { BlobFace } from "./teammate-face.js";
import "./captain-chat.css";

/* Contract v1, as the page reads it (the server's types land in managers.ts; read loosely until then). */
type Autonomy = "ask" | "merge" | "run";
/** The Captain's own lane as it works on a reply (GET /api/managers `captain`, Contract v1 as built). */
interface CaptainLive {
  state: "running" | "waiting" | "idle" | "errored";
  since?: number;
  activity?: string;
  steps?: { at: number; kind: string; text: string; done: boolean }[];
  tokens?: number;
  /** Why it couldn't start, when `state` is "errored". */
  reason?: string;
}
export type ChatPanel = "open" | "closed";
interface PlanTask {
  id: string;
  text: string;
  role: string;
  /** The coding tool the Captain chose for it, when it chose one. */
  tool?: EngineTool;
  after: string[];
  status: "queued" | "running" | "checking" | "done" | "failed" | "blocked";
  agent?: string;
  sid?: string;
  started?: number;
  ended?: number;
  result?: string;
  /** What its agent ran to prove its work (its "Checked:" line). */
  checked?: string;
  /** Worked in a copy of the folder; `applied` once that work is brought in, `skipped` when it was left out. */
  copy?: true;
  applied?: true;
  skipped?: true;
  /** One of two attempts at a risky step, the judge of two, which it picked, and the one it didn't (managers.ts withTwins). */
  twin?: string;
  judge?: [string, string];
  picked?: true;
  lost?: true;
  title?: string;
}
interface Plan {
  id: string;
  goal: string;
  at: number;
  captainUsd?: number;
  status: "draft" | "running" | "done" | "cancelled";
  tasks: PlanTask[];
  /** How many times the Captain revised it after a failure. */
  revision?: number;
  /** Waiting for your go to bring parallel work into the project folder. */
  hold?: { kind: "merge"; tasks: string[]; at: number };
}
interface CaptainAgent {
  id: string;
  name: string;
  role: string;
  /** Why it runs on its tool. */
  why?: string;
  look: string;
  tool: EngineTool;
  model?: string;
  saved?: true;
  sid?: string;
  status: "idle" | "working" | "needs" | "done" | "failed";
  task?: string;
}
type Card = { kind: "plan"; plan: string } | { kind: "update"; agent?: string; task?: string; tone?: "done" | "failed" | "needs" | "info" };
type V2 = ManagerView & { autonomy?: Autonomy; plans?: Plan[]; agents?: CaptainAgent[]; now?: { text: string; label?: string }; captain?: CaptainLive; chat?: (ChatLine & { card?: Card })[] };

/** An agent's state as the page shows it: its lane's live run (the server works it out on each read) over its stored status. The
 *  header, the plan card and the crew tree read it alike, so they agree. */
export type CrewState = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
const LIVE_STATE: Record<string, CrewState> = { running: "running", waiting: "waiting", errored: "failed", stopped: "stopped", gone: "stopped" };
const STORED_STATE: Record<string, CrewState> = { working: "running", needs: "waiting", done: "done", failed: "failed", idle: "queued" };
export const agentState = (x: { status: string; state?: string }): CrewState => {
  // Its step finished (done or failed) and then its tool was stopped or its lane put away, as idle tools are: still Done or Failed,
  // not "Stopped" (Arun, 2026-11-28: "is stopped and still running????", every finished agent said Stopped).
  if ((x.state === "stopped" || x.state === "gone") && (x.status === "done" || x.status === "failed")) return STORED_STATE[x.status]!;
  return (x.state ? LIVE_STATE[x.state] : undefined) ?? STORED_STATE[x.status] ?? "queued";
};
/** Finished steps whose work is still in their copy, not in your folder: what Stop asks about, in the plan card and on the tree. */
export const unappliedOf = (p: { tasks: readonly { status: string; copy?: boolean; applied?: boolean; skipped?: boolean; lost?: boolean; judge?: unknown }[] }) => p.tasks.filter((t) => t.status === "done" && t.copy && !t.applied && !t.skipped && !t.lost && !t.judge);
/**
 * What needs you and what is running, counted once for the header, the plan card and the tree: the Captain's open questions and
 * each agent waiting on you (one whose lane already asked counts once); each agent running, each running step whose agent isn't on
 * the record yet, and the Captain itself while it checks the whole or revises the plan. And the first failed step of a running plan.
 */
export function crewCounts(m0: ManagerView) {
  const m = m0 as V2;
  const agents = m.agents ?? [];
  const asks = forYouOf(m);
  const ids = new Set(agents.map((x) => x.id));
  const live = (m.plans ?? []).filter((p) => p.status === "running");
  const orphans = live.flatMap((p) => p.tasks).filter((t) => (t.status === "running" || t.status === "checking") && (!t.agent || !ids.has(t.agent))).length;
  const own = live.some((p) => (p as Plan & { final?: { status?: string } }).final?.status === "checking" || !!(p as Plan & { revising?: unknown }).revising);
  const running = agents.filter((x) => agentState(x) === "running").length + orphans + (own ? 1 : 0);
  const needs = asks.length + agents.filter((x) => agentState(x) === "waiting" && !asks.some((q) => q.lane && q.lane === (x as { lane?: string }).lane)).length;
  const failing = live.map((p) => p.tasks.findIndex((t) => t.status === "failed")).find((i) => i >= 0);
  return { running, needs, failedAt: failing ?? -1 };
}

const AUTONOMY: { value: Autonomy; label: string; hint: string; icon: IconName }[] = [
  { value: "ask", label: "Ask first", hint: "Each plan waits for you to press Start.", icon: "hand" },
  { value: "merge", label: "Ask before bringing in", hint: "Starts on its own, asks before bringing the crew's work into your folder.", icon: "gitMerge" },
  { value: "run", label: "Run to ready", hint: "Starts and finishes on its own; you review what's ready.", icon: "play" },
];
const autonomyOf = (m: V2): Autonomy => m.autonomy ?? (m.level === "watch" ? "ask" : m.level === "run" ? "run" : "merge");
// Starters that fit any project, new or not (pre-release review: "Fix the failing tests" on a brand-new one).
const QUICK = ["What should we work on next?", "Find and fix bugs", "Tighten up the tests"];

/**
 * The Captain's page around its tabs (Arun, 2026-11-27: "instead of a side chat panel ... integrated in the agents page ... maximize
 * space"): its header in the window's band, what needs you along the top, the tab's content in the middle, and the talk with the
 * Captain as a dock at the foot of every tab. Folded, the dock shows its last word (or the plan waiting for your go) over the box;
 * open, the whole conversation.
 */
export function CaptainChat({
  m: m0,
  api: a,
  headIn,
  onSettings,
  open,
  onBack,
  panel,
  setPanel,
  children,
}: {
  m: ManagerView;
  api: ManagersApi;
  headIn: HTMLElement | null;
  onSettings: () => void;
  open: (sid: string) => void;
  /** Back to the New thread page. */
  onBack: () => void;
  /** The chat beside the crew: open, folded to a strip, or closed (Arun, 2026-11-27: "a side panel that can be collapsed and closed"). */
  panel: ChatPanel;
  setPanel: (p: ChatPanel) => void;
  children: ReactNode;
}) {
  const m = m0 as V2;
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const wide = panel === "open";
  // Its width, dragged by its edge and kept on this computer (Arun, 2026-11-27: "be able to drag and adjust").
  const [width, setWidth] = useState(() => sizeAt("friday.captain.chatW", 380, 300, 720));
  const dragW = (e: React.PointerEvent) => drag(e, "x", width, (v) => setWidth(Math.max(300, Math.min(720, v))), (v) => keepSize("friday.captain.chatW", v));
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  // Its morning digest is for the phone and the sidebar, not the talk (the window left it out too).
  const said = (m.chat ?? []).filter((c) => !(c.who === "captain" && /^Today in .*:/i.test(c.text.trim())));
  // Its agents' running updates ("Coder started…", "…done", "Brought … together") stay out of the talk (Arun, 2026-11-27: "get rid
  // of this"): the crew tree shows how each is doing, and failures and questions come up in the needs card and the Recap.
  // But what you need to see stays (pre-release review): the summary and the end of the work, what was brought into your folder,
  // failures, and what it asked or answered.
  // No update lines at all (Arun, 2026-11-28: "i said to get rid of this stuff", of "Brought…", "Running … again", "All 8 done"):
  // the plan card shows each step, the needs card what needs you, the Recap what came of it. Only the Captain's summary of a
  // finished plan stays, as its reply, and its own tool failing to start (nothing else would say so).
  const reports = new Set((m.plans ?? []).map((p) => (p as { report?: string }).report).filter(Boolean));
  const chat = said.flatMap((c) => {
    const card = (c as { card?: { kind?: string } }).card;
    if (card?.kind !== "update") return [c];
    if (reports.has(c.text)) return [{ ...c, card: undefined } as typeof c];
    return /^Couldn't start /.test(c.text) ? [c] : [];
  });
  // Still waiting on its answer only while nothing of its own came after your last word (an update counts: it heard you).
  // Read from the talk as shown: a hidden update line after your message didn't answer it.
  const thinking = chat.at(-1)?.who === "you";
  const lastSaid = [...chat].reverse().find((c) => c.who === "you")?.text ?? "";
  const counts = crewCounts(m);

  // The new way (plans and its own agents) runs once a Captain has an autonomy: opening its page moves it over, from its old level
  // (Arun, 2026-11-27: replace watch/help/run with the new flow).
  useEffect(() => {
    if (m.autonomy === undefined) void a.change(m.id, { autonomy: autonomyOf(m) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.autonomy]);

  // Opened at its end, and kept there as lines arrive.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, thinking, wide]);

  const say = async (text: string) => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    if (await a.say(m.id, t)) setMsg("");
    setSending(false);
  };
  // An action on a plan that can't reach Friday (or is refused) says so under the box, never fails silently.
  const [actErr, setActErr] = useState("");
  const post = (path: string, body?: unknown) =>
    call<{ managers?: ManagerView[]; error?: string }>(a.identity, `/api/managers/${m.id}${path}`, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
      .then((r) => (r?.error ? setActErr(r.error) : setActErr(""), a.read()))
      .catch((e: Error) => setActErr(e.message || "Couldn't reach Friday. Try again in a moment."));
  const onStart = (pid: string, tasks?: Pick<PlanTask, "id" | "text" | "role" | "after">[], what: TaskAct = "start") =>
    what.startsWith("cancel?")
      ? void post(`/plans/${pid}/cancel`, { [what.slice(7)]: true })
      : void post(`/plans/${pid}/${what}`, tasks ? { tasks } : undefined);
  const onCancel = (pid: string) => void post(`/plans/${pid}/cancel`);

  const head = (
    <header className={`cch-head${headIn ? " in-band" : ""}`}>
      <button type="button" className="cch-icon" onClick={onBack} aria-label="Back to New thread" title="Back to New thread">
        <Icon name="arrowLeft" size={15} />
      </button>
      <ManagerFace m={m} size={headIn ? 22 : 26} />
      <span className="cch-name" title={m.project.folder}>
        {m.project.name}
      </span>
      {/* A failed step, what needs you and who is running come before the Captain's own label ("Waiting for your Start" hid them). */}
      <span className="cch-state">
        {!m.on
          ? "Off"
          : thinking && m.captain?.state === "running"
            ? "Working on your message"
            : counts.failedAt >= 0
              ? `Failed at step ${counts.failedAt + 1}`
              : counts.needs
                ? `${counts.needs} need${counts.needs === 1 ? "s" : ""} you`
                : counts.running
                  ? `Working · ${counts.running} agent${counts.running === 1 ? "" : "s"}`
                  : (m.now?.label ?? m.now?.text ?? "Ready for work")}
      </span>
    </header>
  );

  return (
    <div className="cch" data-testid="captain-chat">
      {headIn ? createPortal(head, headIn) : head}
      {/* What needs you sits in the chat over the box; with the chat closed, the tree's "need you" chip opens the chat to it (Arun,
          2026-11-28: not a strip along the top of the crew). */}
      <div className="cch-body">
      {panel === "open" && (
        <aside className="cch-dock cch-side" aria-label="Talk to the Captain" style={{ width }}>
          <div className="cch-resize" role="separator" aria-orientation="vertical" aria-label="Drag to resize the chat" onPointerDown={dragW} />
          <div className="cch-chatbar">
          <span className="cch-grow" />
          <button type="button" className="cch-ib" onClick={() => void a.newChat(m.id)} disabled={!chat.length} aria-label="New conversation" title={chat.length ? "New conversation" : "Nothing said yet"}>
            <Icon name="plus" size={15} />
          </button>
          <PastChats m={m} a={a} />
          <button type="button" className="cch-ib" onClick={() => setPanel("closed")} aria-label="Close the chat" title="Close the chat">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="cch-scroll" ref={scroller}>
            {!chat.length && !thinking ? (
              <div className="cch-empty">
                {/* Nothing said yet (Arun, 2026-11-27: "design better empty states ... creative and professional"): the Captain, how it
                    works in three steps, and goals to start from. */}
                <span className="cch-empty-face" aria-hidden>
                  <ManagerFace m={m} size={34} />
                </span>
                <h3 className="cch-empty-t">Give {m.project.name} a goal</h3>
                <p className="cch-empty-s">The Captain plans it, puts a crew on it and brings it back ready for you.</p>
                <ol className="cch-how" aria-label="How it works">
                  <li>
                    <Icon name="message" size={13} />
                    <span>You say what should get done</span>
                  </li>
                  <li>
                    <Icon name="users" size={13} />
                    <span>It plans and picks a crew</span>
                  </li>
                  <li>
                    <Icon name="check" size={13} />
                    <span>You review what's ready</span>
                  </li>
                </ol>
                <div className="cch-starts" role="group" aria-label="Goals to start from">
                  {QUICK.map((q) => (
                    <button key={q} type="button" className="cch-start" onClick={() => (setMsg(q), box.current?.focus())}>
                      <span>{q}</span>
                      <Icon name="arrowRight" size={13} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <section className="cch-talk" aria-label="Conversation" aria-live="polite">
                {chat.map((c, i) => (
                  <Line key={`${c.at}:${i}`} c={c} m={m} open={open} onStart={onStart} onCancel={onCancel} onAnswer={(at, text) => void a.answer(m.id, at, text)} />
                ))}
                {thinking && (
                  <CaptainWorking m={m} asked={chat.at(-1)!.at} />
                )}
              </section>
            )}
          </div>
          {/* Answered where you talk to it (Arun, 2026-11-27: "make sure the answer thing is in the chat too"). */}
          <NeedsYou m={m} a={a} open={open} inChat onMerge={(pid) => void post(`/plans/${pid}/merge`)} />
          <div className="cch-dock-bar">
            <span className="cch-grow" />
            <AutonomyPicker value={autonomyOf(m)} onChange={(v) => void a.change(m.id, { autonomy: v })} />
          </div>
          <div className="composer-box mgr-composer">
            <PromptInput onSubmit={() => void say(msg)} className="prompt">
              <PromptInputBody className="prompt-field relative block">
                <PromptInputTextarea
                  ref={box}
                  aria-label="Message the Captain"
                  className="mgr-composer-ta"
                  value={msg}
                  onChange={(e) => setMsg(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // ↑ in an empty box brings back what you last said, to change and send again; Esc empties it.
                    if (e.key === "ArrowUp" && !msg && lastSaid) (e.preventDefault(), setMsg(lastSaid));
                    else if (e.key === "Escape" && msg) (e.preventDefault(), e.stopPropagation(), setMsg(""));
                  }}
                  autoFocus
                  placeholder={`What should get done in ${m.project.name}?`}
                  disabled={sending}
                />
              </PromptInputBody>
              <PromptInputFooter>
                <span />
                <div className="flex items-center gap-1 composer-send">
                  <PromptInputSubmit status={sending ? "submitted" : undefined} disabled={sending || !msg.trim()} aria-label="Send">
                    {sending ? undefined : <ArrowUpIcon className="size-4" />}
                  </PromptInputSubmit>
                </div>
              </PromptInputFooter>
            </PromptInput>
          </div>
          {(a.error || actErr) && <p className="mgr-error">{a.error || actErr}</p>}
        </aside>
      )}
      <div className="cch-main">{children}</div>
      </div>
    </div>
  );
}

/** What needs you, on top: its own questions, and any agent or thread waiting on a go-ahead (answered in the thread). */
function NeedsYou({ m, a, open, inChat = false, onMerge }: { m: V2; a: ManagersApi; open: (sid: string) => void; inChat?: boolean; onMerge?: (pid: string) => void }) {
  type Ask = ReturnType<typeof forYouOf>[number] & { options?: string[]; hold?: { pid: string; kind: string } };
  const asks = forYouOf(m) as Ask[];
  const oks = [
    ...(m.agents ?? []).filter((x) => x.status === "needs" && x.sid && !asks.some((q) => q.lane && q.lane === (x as { lane?: string }).lane)).map((x) => ({ key: x.id, who: x.name, what: "is waiting on your go-ahead", sid: x.sid! })),
    ...(m.threads ?? [])
      .filter((t) => t.state === "needs" && !(m.agents ?? []).some((x) => x.sid === t.sid))
      .map((t) => ({ key: t.sid, who: t.title || "A thread", what: t.ask ? `wants to run ${t.ask}` : (t as { question?: string }).question ? `asks: ${(t as { question?: string }).question}` : "is waiting on your go-ahead", sid: t.sid })),
  ];
  const [answering, setAnswering] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  // The Recap's Review on a question opens its answer here (captain-places.tsx dispatches friday:captain-answer with its `at`).
  useEffect(() => {
    const on = (e: Event) => {
      // Its `at`, given bare or as { at } (the Recap sends the second).
      const d = (e as CustomEvent<number | { at?: number }>).detail;
      const at = Number(typeof d === "object" && d ? d.at : d);
      if (Number.isFinite(at)) (setAll(true), setAnswering(at), setText(""));
    };
    addEventListener("friday:captain-answer", on);
    return () => removeEventListener("friday:captain-answer", on);
  }, []);
  const [opened, setOpened] = useState<number | null>(null);
  const n = asks.length + oks.length;
  if (!n) return null;
  // One row each, two at most until you ask for the rest, so the talk keeps its room (pre-release review: it squeezed the chat).
  const shownAsks = all ? asks : asks.slice(0, 2);
  const shownOks = all ? oks : oks.slice(0, Math.max(0, 2 - shownAsks.length));
  const hidden = n - shownAsks.length - shownOks.length;
  return (
    <section className={`cch-needs${inChat ? " in-chat" : ""}`} aria-label="Needs you">
      {shownOks.map((o) => (
        <div key={o.key} className="cch-need">
          <Icon name="flag" size={13} />
          <span className="cch-need-t">
            <b>{o.who}</b> {o.what}
          </span>
          <button type="button" className="cch-btn" onClick={() => open(o.sid)}>
            Open
          </button>
        </div>
      ))}
      {shownAsks.map((x) =>
        x.hold?.kind === "merge" && onMerge ? (
          <div key={x.at} className="cch-need">
            <Icon name="gitMerge" size={13} />
            <span className="cch-need-t">{x.text}</span>
            <button type="button" className="cch-btn" onClick={() => window.dispatchEvent(new CustomEvent("friday:captain-panel", { detail: "changes" }))}>
              Look first
            </button>
            <button type="button" className="cch-btn primary" onClick={() => onMerge(x.hold!.pid)}>
              Bring it together
            </button>
          </div>
        ) : answering === x.at ? (
          <form
            key={x.at}
            className="cch-need ans"
            onSubmit={(e) => (e.preventDefault(), text.trim() && void a.answer(m.id, x.at, text.trim()).then(() => (setAnswering(null), setText(""))))}
          >
            <span className="cch-need-t full">{x.text}</span>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setAnswering(null)}
              placeholder="Your answer"
              aria-label={`Answer: ${x.text}`}
            />
            <button type="submit" className="cch-btn primary" disabled={!text.trim()}>
              Send
            </button>
          </form>
        ) : (
          <div key={x.at} className="cch-need ask">
            <Icon name="message" size={13} />
            {/* The whole question, three lines until a press opens the rest; the sidebar keeps the short form. */}
            <button type="button" className={`cch-need-t q${opened === x.at ? " open" : ""}`} title={x.text} onClick={() => setOpened(opened === x.at ? null : x.at)}>
              {x.text}
            </button>
            <span className="cch-need-acts">
              {(x.options ?? []).slice(0, 3).map((o, k) => (
                <button key={o} type="button" className={`cch-btn${k === 0 ? " primary" : ""}`} onClick={() => void a.answer(m.id, x.at, o)}>
                  {o}
                </button>
              ))}
              <button type="button" className="cch-btn" onClick={() => void a.answer(m.id, x.at, null)}>
                Dismiss
              </button>
              <button type="button" className={`cch-btn${(x.options ?? []).length ? "" : " primary"}`} onClick={() => (setAnswering(x.at), setText(""))}>
                {(x.options ?? []).length ? "Reply" : "Answer"}
              </button>
            </span>
          </div>
        ),
      )}
      {hidden > 0 && (
        <button type="button" className="cch-need-more" onClick={() => setAll(true)}>
          {hidden} more waiting on you
        </button>
      )}
    </section>
  );
}

function Line({
  c,
  m,
  open,
  onStart,
  onCancel,
  onAnswer,
}: {
  c: ChatLine & { card?: Card };
  m: V2;
  open: (sid: string) => void;
  onStart: (pid: string, tasks?: Pick<PlanTask, "id" | "text" | "role" | "after">[], what?: TaskAct) => void;
  onCancel: (pid: string) => void;
  onAnswer?: (at: number, text: string | null) => void;
}) {
  if (c.who === "you")
    return (
      <div className="mgr-msg you" title={clockOf(c.at)}>
        {c.text}
      </div>
    );
  const card = c.card;
  if (card?.kind === "update") {
    const ag = (m.agents ?? []).find((x) => x.id === card.agent || x.name === card.agent);
    return (
      <div className={`cch-update ${card.tone ?? "info"}`} title={clockOf(c.at)}>
        {ag ? (
          <span className="cch-face sm" aria-hidden>
            <BlobFace seed={ag.look} size={14} hat />
          </span>
        ) : (
          <span className="cch-dot" aria-hidden />
        )}
        <span className="cch-update-t">{c.text}</span>
        <span className="cch-tone" aria-hidden />
      </div>
    );
  }
  const plan = card?.kind === "plan" ? (m.plans ?? []).find((p) => p.id === card.plan) : undefined;
  return (
    <div className="cch-say">
      {c.text && (
        <div className="cch-reply">
          <div className="mgr-msg captain md" title={clockOf(c.at)} dangerouslySetInnerHTML={{ __html: md(c.text) }} />
          <CopyReply text={c.text} />
        </div>
      )}
      {plan && <PlanCard plan={plan} m={m} open={open} onStart={onStart} onCancel={onCancel} onAnswer={onAnswer} />}
    </div>
  );
}

/** A step's short name: its own title when the plan gave one, else the part of its brief before a colon, else its first words. */
const titleOf = (t: { text: string; title?: string }) => {
  if (t.title) return t.title;
  const head = t.text.split(":")[0]!.trim();
  if (head.length > 3 && head.length <= 60 && head !== t.text.trim()) return head;
  const words = t.text.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
};
/** The brief without its title. */
const briefOf = (t: { text: string }) => (t.text.includes(":") && t.text.split(":")[0]!.length <= 60 ? t.text.slice(t.text.indexOf(":") + 1).trim() : t.text);
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
/** "claude-sonnet-5-5" or "sonnet" as the app names it: "Sonnet 5.5". */
const prettyModel = (tool: EngineTool, id: string) => {
  const known = ENGINE_MODEL_INFO[tool]?.find((x) => x.id === id || id.endsWith(x.id))?.label;
  if (known) return known;
  const words = id.replace(/^claude-|^gpt-|^gemini-/i, "").split("-");
  const name = words.filter((w) => !/^\d+$/.test(w)).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  const ver = words.filter((w) => /^\d+$/.test(w)).join(".");
  return [name, ver].filter(Boolean).join(" ") || id;
};
const modelLabel = (ag: CaptainAgent) => (ag.model ? prettyModel(ag.tool, ag.model) : ENGINE_NAMES[ag.tool]);

type TaskAct = string; // "start" | "merge" | `tasks/${id}/retry` | `tasks/${id}/skip`

/**
 * The plan card (Arun, 2026-11-27: "build this for the plan thing", product/plan-card-mocks.html, after affectUI's Agent Plan): a
 * bar with a segment per step in its state's colour; a finished step is two short lines (its area, who and how long; what it came
 * to), opened by a press into what it was asked and what it did; the running step and anything waiting on you open on their own,
 * with the agent's question and a reply right in the card; a failed step says what broke with Retry and Skip. A draft is edited in
 * place and started with ⌘↵.
 */
function PlanCard({
  plan,
  m,
  onStart,
  onCancel,
  onAnswer,
}: {
  plan: Plan;
  m: V2;
  open: (sid: string) => void;
  onStart: (pid: string, tasks?: Pick<PlanTask, "id" | "text" | "role" | "after">[], what?: TaskAct) => void;
  onCancel: (pid: string) => void;
  onAnswer?: (at: number, text: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => plan.tasks.map((t) => ({ id: t.id, text: t.text, role: t.role, after: t.after })));
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [reply, setReply] = useState<Record<string, string>>({});
  // Stop asks what to do with steps already finished but not yet in your folder (pre-release review: Stop lost them silently).
  const [stopping, setStopping] = useState(false);
  const now = useNowMinute();
  const isDraft = plan.status === "draft";
  const agentOf = (t: PlanTask) => (m.agents ?? []).find((x) => x.id === t.agent);
  const asks = forYouOf(m);
  const askOf = (t: PlanTask) => {
    const ag = agentOf(t);
    return (t as PlanTask & { ask?: { at: number; text: string; options?: string[] } }).ask ?? (ag?.lane ? asks.find((x) => x.lane === ag.lane) : undefined);
  };
  const stateOf = (t: PlanTask): "done" | "run" | "wait" | "fail" | "queued" => {
    if (t.status === "done") return "done";
    if (t.status === "failed") return "fail";
    const ag = agentOf(t);
    // Waiting on you as the header and the tree read it: its lane's live state over its stored status.
    if (askOf(t) || (ag && agentState(ag) === "waiting")) return "wait";
    if (t.status === "running" || t.status === "checking") return "run";
    return "queued";
  };
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const failedAt = plan.tasks.findIndex((t) => t.status === "failed");
  const failedN = plan.tasks.filter((t) => t.status === "failed").length;
  // Finished steps whose agent's work isn't in the project folder yet (GET /api/managers agents[].applied).
  const unapplied = unappliedOf(plan);
  const pv = plan as Plan & { final?: { status?: string; why?: string }; revising?: boolean };
  const waiting = plan.tasks.filter((t) => stateOf(t) === "wait").length;
  const runningN = plan.tasks.filter((t) => stateOf(t) === "run").length;
  // Its clock from the first step's start (the plan's own time is when it was drafted), held still once it is done or stopped.
  const starts = plan.tasks.flatMap((t) => (t.started ? [t.started] : []));
  const first = starts.length ? Math.min(...starts) : plan.at;
  const last = Math.max(...plan.tasks.map((t) => t.ended ?? 0));
  const ended = plan.status === "done" || plan.status === "cancelled";
  // Each agent once (one that took two steps was counted twice).
  const usd = [...new Set(plan.tasks.flatMap((t) => (t.agent ? [t.agent] : [])))].reduce((n, id) => n + (((m.agents ?? []).find((x) => x.id === id) as (CaptainAgent & { usd?: number }) | undefined)?.usd ?? 0), plan.captainUsd ?? 0);
  const start = () => onStart(plan.id, editing ? draft.filter((t) => t.text.trim()) : undefined);
  const toggle = (id: string) => setOpened((o) => toggled(o, id));
  const head = (
    <div className="plc-head">
      <div className="plc-r">
        <b>The plan</b>
        <span className="plc-m">
          {plan.tasks.length} step{plan.tasks.length === 1 ? "" : "s"}
          {plan.revision ? ` · revised${plan.revision > 1 ? ` ×${plan.revision}` : ""}` : ""}
        </span>
        <span className="plc-right">
          {isDraft ? (
            <span className="plc-amber">Waiting for your go</span>
          ) : (
            <>
              <b>{done}</b> of {plan.tasks.length} done · {span((ended && last ? last : now) - first)}
              {failedN > 0 && <span className="plc-red"> · {failedN} failed</span>}
            </>
          )}
        </span>
      </div>
      {!isDraft && (
        <div className="plc-seg" aria-hidden>
          {plan.tasks.map((t) => {
            const st = stateOf(t);
            return <i key={t.id} className={st === "queued" ? "" : st} />;
          })}
        </div>
      )}
    </div>
  );
  return (
    <div className={`plc ${plan.status}`} onKeyDown={(e) => isDraft && e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), start())} aria-label={`Plan, ${plan.tasks.length} steps`}>
      {head}
      <ol className="plc-steps">
        {(editing ? draft : plan.tasks).map((d, i) => {
          const t = plan.tasks.find((x) => x.id === d.id) ?? (d as PlanTask);
          const st = isDraft ? "queued" : stateOf(t);
          const ag = agentOf(t);
          const ask = askOf(t);
          const live = ag as (CaptainAgent & { activity?: string; usd?: number; since?: number }) | undefined;
          // The running step, what waits on you and a failure open on their own; a finished one on a press.
          const auto = st === "run" || st === "wait" || st === "fail";
          const isOpen = auto || opened.has(t.id);
          const when = st === "done" && t.started && t.ended ? span(t.ended - t.started) : st === "run" && t.started ? null : st === "queued" ? (failedAt >= 0 ? "held" : i === plan.tasks.findIndex((x) => stateOf(x) === "queued") ? "next" : "") : "";
          if (editing)
            return (
              <li key={d.id} className="plc-st queued editing">
                <span className="plc-ring">{i + 1}</span>
                <div className="plc-l1">
                  <input className="plc-in role" value={d.role} aria-label={`Who takes step ${i + 1}`} onChange={(e) => setDraft((x) => x.map((y) => (y.id === d.id ? { ...y, role: e.currentTarget.value } : y)))} />
                </div>
                <textarea className="plc-in text" rows={3} value={d.text} aria-label={`Step ${i + 1}`} onChange={(e) => setDraft((x) => x.map((y) => (y.id === d.id ? { ...y, text: e.currentTarget.value } : y)))} />
                <button type="button" className="plc-del" onClick={() => setDraft((x) => x.filter((y) => y.id !== d.id))} aria-label={`Remove step ${i + 1}`} title="Remove this step" disabled={draft.length < 2}>
                  <Icon name="trash" size={13} />
                </button>
              </li>
            );
          return (
            <li key={t.id} className={`plc-st ${st}${opened.has(t.id) ? " open" : ""}${t.lost ? " lost" : ""}`}>
              <span className="plc-ring" aria-hidden>
                {st === "done" ? <Icon name="check" size={11} strokeWidth={2.2} /> : st === "fail" ? "!" : st === "run" ? null : i + 1}
              </span>
              <button type="button" className="plc-l1" onClick={() => !auto && toggle(t.id)} aria-expanded={isOpen} disabled={auto}>
                <span className="plc-t" title={t.text}>
                  {titleOf(t)}
                </span>
                <span className="plc-who">
                  <span className="plc-av" aria-hidden>
                    <BlobFace seed={ag?.look ?? `${m.project.name}:${t.role}`} size={16} hat />
                  </span>
                  {/* Its name, and opened, its role (an old "Coder 2" is already its role: its model then, as before). */}
                  <span className="plc-who-n">
                    {ag?.name ?? t.role}
                    {isOpen && ag ? ` · ${ag.role && !ag.name.startsWith(ag.role) ? ag.role : modelLabel(ag)}` : ""}
                  </span>
                  {/* The tool the Captain chose for a step not started yet. */}
                  {!ag && t.tool && (
                    <span className="plc-tool" title={`The Captain chose ${ENGINE_NAMES[t.tool]} for this step`}>
                      <EngineMark tool={t.tool} size={11} />
                      {ENGINE_NAMES[t.tool]}
                    </span>
                  )}
                </span>
                {t.lost ? (
                  <span className="plc-chip" title={t.result}>Not picked</span>
                ) : t.picked && st === "done" ? (
                  <span className="plc-chip grn">Picked</span>
                ) : st === "wait" ? (
                  <span className="plc-chip amb">Needs you</span>
                ) : st === "fail" ? (
                  <span className="plc-chip red">Failed</span>
                ) : st === "run" && t.started ? (
                  <LiveClock since={t.started} className="plc-when live" />
                ) : (
                  <span className="plc-when">{when}</span>
                )}
              </button>
              {!isOpen && st === "done" && t.result && <p className="plc-l2">{t.result}</p>}
              {isOpen && (
                <div className="plc-more">
                  {st === "run" && <p className="plc-l2 now"><Shine>{live?.activity || "Working on it"}</Shine></p>}
                  {st === "run" && (
                    <div className="plc-facts">
                      {live?.usd ? <span><b>${live.usd.toFixed(2)}</b> so far</span> : null}
                      {ag && (
                        <span title={ag.why ? `${ENGINE_NAMES[ag.tool]}: ${ag.why}` : undefined}>
                          <EngineMark tool={ag.tool} size={11} /> {ENGINE_NAMES[ag.tool]}
                          {ag.why ? <em className="plc-why"> · {ag.why}</em> : null}
                        </span>
                      )}
                    </div>
                  )}
                  {st === "wait" && (
                    <div className="plc-ask">
                      <p>{ask ? askShort(ask.text) === ask.text ? ask.text : ask.text : `${ag?.name ?? "The agent"} is waiting on your go-ahead in its lane.`}</p>
                      {ask && onAnswer && (
                        <form className="plc-acts" onSubmit={(e) => (e.preventDefault(), (reply[t.id] ?? "").trim() && (onAnswer(ask.at, reply[t.id]!.trim()), setReply((r) => ({ ...r, [t.id]: "" }))))}>
                          {((ask as { options?: string[] }).options ?? []).map((o, k) => (
                            <button key={o} type="button" className={`cch-btn${k === 0 ? " primary" : ""}`} onClick={() => onAnswer(ask.at, o)}>
                              {o}
                            </button>
                          ))}
                          <input className="plc-in reply" value={reply[t.id] ?? ""} onChange={(e) => setReply((r) => ({ ...r, [t.id]: e.currentTarget.value }))} placeholder="Reply…" aria-label={`Reply to ${ag?.name ?? "the agent"}`} />
                          <button type="submit" className="cch-btn" disabled={!(reply[t.id] ?? "").trim()}>
                            Send
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                  {st === "fail" && (
                    <>
                      {t.result && <div className="plc-err">{t.result}</div>}
                      <div className="plc-acts">
                        <button type="button" className="cch-btn primary" onClick={() => onStart(plan.id, undefined, `tasks/${t.id}/retry`)}>
                          Retry this step
                        </button>
                        <button type="button" className="cch-btn" onClick={() => onStart(plan.id, undefined, `tasks/${t.id}/skip`)}>
                          Skip it
                        </button>
                      </div>
                    </>
                  )}
                  {st === "done" && (
                    <>
                      <p className="plc-p">
                        <b>Asked:</b> {briefOf(t)}
                      </p>
                      {t.result && (
                        <p className="plc-p">
                          <b>Did:</b> {t.result}
                        </p>
                      )}
                      {t.checked && <p className="plc-p plc-checked">Checked: {t.checked}</p>}
                      {((t as PlanTask & { files?: string[] }).files ?? []).length > 0 && (
                        <div className="plc-files">
                          {(t as PlanTask & { files?: string[] }).files!.slice(0, 8).map((f) => (
                            <code key={f}>{f.split("/").pop()}</code>
                          ))}
                        </div>
                      )}
                      <div className="plc-facts">
                        {(t as PlanTask & { added?: number; removed?: number }).added != null && (
                          <span>
                            <b>+{(t as PlanTask & { added?: number }).added}</b> −{(t as PlanTask & { removed?: number }).removed ?? 0}
                          </span>
                        )}
                        {live?.usd ? <span><b>${live.usd.toFixed(2)}</b></span> : null}
                        {t.started && t.ended ? <span>{span(t.ended - t.started)}</span> : null}
                      </div>
                    </>
                  )}
                  {st === "queued" && <p className="plc-p">{briefOf(t)}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {plan.hold?.kind === "merge" && (
        <div className="cch-plan-hold" role="status">
          <Icon name="gitMerge" size={13} />
          <span>Work from {plan.hold.tasks.length} step{plan.hold.tasks.length === 1 ? "" : "s"} is ready to bring together into the project folder.</span>
          <button type="button" className="cch-btn primary" onClick={() => onStart(plan.id, undefined, "merge")}>
            Bring it together
          </button>
        </div>
      )}
      {stopping && (
        <div className="plc-stop" role="alertdialog" aria-label="Stop the plan">
          <span>
            {unapplied.length} finished step{unapplied.length === 1 ? " hasn't" : "s haven't"} been brought into your folder yet.
          </span>
          <span className="plc-acts">
            <button type="button" className="cch-btn" onClick={() => setStopping(false)} autoFocus>
              Keep going
            </button>
            <button type="button" className="cch-btn" onClick={() => (setStopping(false), onStart(plan.id, undefined, "cancel?discard"))}>
              Discard and stop
            </button>
            <button type="button" className="cch-btn primary" onClick={() => (setStopping(false), onStart(plan.id, undefined, "cancel?apply"))}>
              Bring them in and stop
            </button>
          </span>
        </div>
      )}
      <div className="plc-foot">
        {isDraft ? (
          <>
            <button type="button" className="cch-btn" onClick={() => onCancel(plan.id)} title="Throw this plan away; ask again for a new one">
              Discard plan
            </button>
            <span className="cch-grow" />
            {editing && (
              <button type="button" className="cch-btn" onClick={() => setDraft((x) => [...x, { id: `n${Date.now()}`, text: "", role: "Coder", after: [] }])}>
                <Icon name="plus" size={13} />
                Add a step
              </button>
            )}
            {/* Edit starts from the plan as it stands now, not as it was when the card first showed. */}
            <button type="button" className="cch-btn" onClick={() => (!editing && setDraft(plan.tasks.map((t) => ({ id: t.id, text: t.text, role: t.role, after: t.after }))), setEditing((e) => !e))}>
              {editing ? "Done editing" : "Edit"}
            </button>
            <button type="button" className="cch-btn primary" onClick={start}>
              Start <kbd>⌘↵</kbd>
            </button>
          </>
        ) : plan.status === "done" ? (
          <>
            <span className="plc-tick">
              <Icon name="check" size={13} strokeWidth={2.2} />
            </span>
            <span>
              Done in <b>{span((last || now) - first)}</b>
              {usd ? ` · $${usd.toFixed(2)}` : ""}
              {unapplied.length ? " · not in your folder yet" : plan.tasks.some((t) => t.applied) ? " · brought into your folder" : " · nothing committed yet"}
            </span>
            <span className="cch-grow" />
            {/* From ready to looking it over (pre-release review: no way from "ready" to review): the crew's changes, file by file. */}
            <button type="button" className="cch-btn primary" onClick={() => (window.dispatchEvent(new CustomEvent("friday:captain-panel", { detail: "changes" })), onStart(plan.id, undefined, "seen"))}>
              Review changes
            </button>
          </>
        ) : plan.hold?.kind === "merge" ? (
          <>
            <span className="plc-dot amber" aria-hidden />
            <span>Waiting for your go to bring the work in</span>
          </>
        ) : pv.revising ? (
          <>
            <span className="plc-spin" aria-hidden />
            <Shine>Revising the plan</Shine>
          </>
        ) : pv.final?.status === "checking" ? (
          <>
            <span className="plc-spin" aria-hidden />
            <Shine>Checking the whole change</Shine>
          </>
        ) : pv.final?.status === "failed" ? (
          <>
            <span className="plc-dot red" aria-hidden />
            <span>Check failed{pv.final.why ? `: ${pv.final.why}` : ""}</span>
          </>
        ) : failedAt >= 0 && runningN === 0 ? (
          <>
            <span className="plc-dot red" aria-hidden />
            <span>Held at step {failedAt + 1}</span>
            <span className="cch-grow" />
            <span>Retry or skip it to carry on</span>
          </>
        ) : plan.status === "running" ? (
          <>
            {runningN > 0 && <span className="plc-spin" aria-hidden />}
            <Shine>{runningN > 0 ? `${runningN} running` : "Between steps"}</Shine>
            <span className="cch-grow" />
            {/* A failed step holds what comes after it while the others still run: said beside them, Stop still there. */}
            {failedAt >= 0 && (
              <span className="plc-held">
                <span className="plc-dot red" aria-hidden />
                Held at step {failedAt + 1}
              </span>
            )}
            {waiting > 0 && <span>{waiting} wait{waiting === 1 ? "s" : ""} on you</span>}
            <button type="button" className="cch-btn" onClick={() => (unapplied.length ? setStopping(true) : onCancel(plan.id))}>
              Stop
            </button>
          </>
        ) : (
          <span>Stopped</span>
        )}
      </div>
    </div>
  );
}

/** Now, to the minute: enough for "18m" in a plan's head. */
function useNowMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const toggled = (set: ReadonlySet<string>, id: string) => {
  const n = new Set(set);
  if (!n.delete(id)) n.add(id);
  return n;
};

/**
 * Past conversations behind a clock: a press opens them in a small card; one opens back in place of this one. Each can be
 * deleted (Arun, 2026-11-27: "add delete button too"): its bin turns into a red Delete on the first press, so one slip loses
 * nothing. Arrows move, Enter opens, Delete or Backspace asks to delete.
 */
function PastChats({ m, a }: { m: V2; a: ManagersApi }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState<number | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const past = m.pastChats ?? [];
  const when = (at: number) => {
    const d = new Date(at);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
    return days === 0 ? `Today ${clockOf(at)}` : days === 1 ? `Yesterday ${clockOf(at)}` : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const rows = useRef<HTMLDivElement>(null);
  const move = (e: React.KeyboardEvent, i: number, at: number) => {
    const all = [...(rows.current?.querySelectorAll<HTMLButtonElement>(".cch-pop-row") ?? [])];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") (e.preventDefault(), all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus());
    else if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), sure === at ? void a.deleteChat(m.id, at).then(() => setSure(null)) : setSure(at));
  };
  return (
    <>
      <button ref={btn} type="button" className={`cch-ib${open ? " on" : ""}`} onClick={() => (setOpen((o) => !o), setSure(null))} aria-haspopup="dialog" aria-expanded={open} aria-label="Past conversations" title="Past conversations">
        <Icon name="clock" size={15} />
      </button>
      <Popover open={open} onClose={() => (setOpen(false), setSure(null))} anchor={btn} side="bottom" align="start" width={300} unstyled className="cch-pop" aria-label="Past conversations">
        <div className="cch-pop-head">Past conversations</div>
        {past.length ? (
          <div className="cch-pop-list" ref={rows} role="list">
            {past.map((c, i) => (
              <div key={c.at} className={`cch-pop-item${sure === c.at ? " sure" : ""}`} role="listitem">
                <button type="button" className="cch-pop-row" onClick={() => (setOpen(false), void a.openChat(m.id, c.at))} onKeyDown={(e) => move(e, i, c.at)}>
                  <span className="cch-pop-t">{c.title || "A conversation"}</span>
                  <span className="cch-pop-s">
                    {when(c.at)} · {c.lines.length} message{c.lines.length === 1 ? "" : "s"}
                  </span>
                </button>
                {sure === c.at ? (
                  <button type="button" className="cch-pop-del sure" autoFocus onClick={() => void a.deleteChat(m.id, c.at).then(() => setSure(null))} onBlur={() => setSure(null)} aria-label={`Delete "${c.title}" for good`}>
                    Delete
                  </button>
                ) : (
                  <button type="button" className="cch-pop-del" onClick={() => setSure(c.at)} aria-label={`Delete "${c.title}"`} title="Delete">
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="cch-pop-empty">No earlier conversations yet. The + button puts this one here and starts fresh.</p>
        )}
      </Popover>
    </>
  );
}

/** How far the Captain goes on its own: the mode's mark and name; a press opens each mode with what it means. */
function AutonomyPicker({ value, onChange }: { value: Autonomy; onChange: (v: Autonomy) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = AUTONOMY.find((x) => x.value === value)!;
  return (
    <>
      <button ref={btn} type="button" className={`cch-mode${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={`How far it goes on its own: ${cur.label}`}>
        <Icon name={cur.icon} size={13} />
        {cur.label}
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} side="top" align="end" width={320} unstyled className="cch-pop" aria-label="How far it goes on its own">
        <div className="cch-pop-head">How far it goes on its own</div>
        <ul className="cch-pop-list" role="listbox" aria-label="Modes">
          {AUTONOMY.map((x) => (
            <li key={x.value}>
              <button type="button" role="option" aria-selected={x.value === value} className={`cch-pop-row mode${x.value === value ? " on" : ""}`} onClick={() => (setOpen(false), x.value !== value && onChange(x.value))}>
                <span className="cch-pop-ic">
                  <Icon name={x.icon} size={14} />
                </span>
                <span className="cch-pop-txt">
                  <span className="cch-pop-t">{x.label}</span>
                  <span className="cch-pop-s">{x.hint}</span>
                </span>
                {x.value === value && <Icon name="check" size={14} />}
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

/* Sizes a panel is dragged to, kept on this computer (a private window keeps them for the visit). */
export function sizeAt(key: string, d: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : d;
  } catch {
    return d;
  }
}
export function keepSize(key: string, v: number) {
  try {
    localStorage.setItem(key, String(Math.round(v)));
  } catch {
    /* kept for this visit only */
  }
}
/** A drag from a panel's edge: `x` grows to the right, `y` grows upward (a panel along the foot). */
export function drag(e: React.PointerEvent, axis: "x" | "y", from: number, set: (v: number) => void, done: (v: number) => void) {
  e.preventDefault();
  const start = axis === "x" ? e.clientX : e.clientY;
  let last = from;
  document.documentElement.classList.add(axis === "x" ? "cpt-dragging-x" : "cpt-dragging-y");
  const move = (ev: PointerEvent) => {
    last = from + (axis === "x" ? ev.clientX - start : start - ev.clientY);
    set(last);
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    document.documentElement.classList.remove("cpt-dragging-x", "cpt-dragging-y");
    done(last);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

const STEP_ICON: Record<string, IconName> = { read: "file", edit: "pencil", run: "terminalSquare", search: "search", web: "globe", think: "message", other: "zap" };

/**
 * The Captain at work on your message (Arun, 2026-11-27: "don't just have it at thinking"): what it is doing now, how long it has
 * been at it, and the steps it has taken this turn, live, as a session's working turn shows them.
 */
function CaptainWorking({ m, asked }: { m: V2; asked: number }) {
  const live = m.captain;
  // Only this turn's: steps and words from a turn that began before your message (one stopped when its tool went away) aren't
  // what it's doing for you, and its clock had run on from then (1m 13s on a message sent seconds before).
  const fresh = !!live?.since && live.since >= asked - 2000;
  const since = fresh ? live!.since! : asked;
  const steps = fresh ? (live?.steps ?? []) : [];
  const failed = live?.state === "errored";
  const word = m.plans?.some((p) => p.status === "running") ? "Working on it" : "Planning";
  const now = (fresh && live?.activity) || `${word}…`;
  return (
    <div className="cch-work" role="status" aria-live="polite">
      <div className="cch-work-head">
        <span className="cch-work-face" aria-hidden>
          <ManagerFace m={m} size={18} />
        </span>
        {failed ? <span>Couldn't go on</span> : <Shine>{now}</Shine>}
        <span className="cch-grow" />
        {!failed && <LiveClock since={since} className="cch-work-clock" />}
      </div>
      {steps.length > 0 && (
        <ol className="cch-work-steps">
          {steps.slice(-6).map((x, i) => (
            <li key={`${x.at}:${i}`} className={x.done ? "done" : "now"}>
              <Icon name={STEP_ICON[x.kind] ?? "zap"} size={12} />
              <span>{x.text}</span>
              {x.done && <Icon name="check" size={11} />}
            </li>
          ))}
        </ol>
      )}
      {live?.state === "errored" && <p className="cch-work-err">{live.reason ?? "It hit an error on this turn."} Send your message again, or check {ENGINE_NAMES[m.tool as EngineTool] ?? "its coding tool"} on this computer.</p>}
    </div>
  );
}

/** Copy a reply, its tick for a moment once it's on the clipboard. */
function CopyReply({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="cch-copy" aria-label={done ? "Copied" : "Copy the reply"} title={done ? "Copied" : "Copy"} onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}>
      <Icon name={done ? "check" : "copy"} size={12} />
    </button>
  );
}
