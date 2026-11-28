/**
 * The Captain's window, its settings and the New Captain sheet: loaded the first time one opens, so the sidebar's Captains don't
 * weigh on the first screen (2026-11-25: the first load went 2 KB over its budget with the simple window).
 */
import { createPortal } from "react-dom";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Badge } from "./components/affect/badge.js";
import { Button } from "./components/affect/button.js";
import { Popover } from "./components/affect/popover.js";
import { SegmentedControl } from "./components/affect/segmented-control.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ChatLine, Manager, ManagerAct, ManagerLevel, ManagerTask, ReadyItem } from "../managers.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool } from "../types.js";
import { MISSION_ROUNDS } from "../missions.js";
import { runClock } from "../step-words.js";
import { AgentModelPicker, wordOf } from "./AgentModelPicker.js";
import { EngineMark } from "./BrandMarks.js";
import { useEngineModelInfo } from "./EngineModelPill.js";
import { useMachine } from "./local.js";
import { Icon, type IconName } from "./icons.js";
import type { Identity } from "./storage.js";
import { MenuButton, Picker, Switch, useConfirm } from "./ui.js";
import { md } from "./markdown.js";
import { LiveClock, elapsed } from "./presence.js";
import { Shine } from "./shine.js";
import { ArrowUpIcon } from "lucide-react";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { askShort, clockOf, forYouOf, managerFor, progressOf, readyFacts, ManagerFace, ProgressRing, StatusChip, type LiveView, type ManagedProject, type ManagerView, type ManagersApi } from "./Managers.js";
import { BlobFace } from "./teammate-face.js";
import { api } from "./api.js";

/** One of Run's options as a small on/off chip: a switch to a screen reader, its words always showing. */
function RunChip({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={`mgr-chip${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <Icon name={on ? "check" : "plus"} size={11} />
      {children}
    </button>
  );
}
/** A status icon whose shape says the state without its colour (managers.css .mgr-si); here, not in Managers.tsx, which loads first. */
type StatusTone = "working" | "needs" | "done" | "failed" | "idle" | "queued";
const StatusIcon = ({ s }: { s: StatusTone }) => <span className={`mgr-si ${s}`} aria-hidden />;

/**
 * What it did while you were away (managers.ts awayReport, here because that file reaches for node modules): what it decided for
 * you, what's ready, what still waits on you and what failed its check. Null when there's no Away or nothing happened in it.
 */
function awayOf(m: ManagerView, now = Date.now()): { since: number; end: number; decided: ManagerAct[]; ready: ReadyItem[]; waiting: ManagerAct[]; failed: ManagerAct[]; stuck: { sid: string; title: string; since: number }[] } | null {
  const a = m.away;
  if (!a) return null;
  const end = a.back ?? now;
  const inside = (at: number) => at >= a.since && at <= end;
  const decided = m.log.filter((x) => x.kind === "assumed" && inside(x.at));
  const ready = (m.ready ?? []).filter((r) => inside(r.at));
  const waiting = forYouOf(m, now).filter((x) => inside(x.at));
  const failed = m.log.filter((x) => x.kind === "sent-back" && inside(x.at));
  const stuck = (m.threads ?? []).filter((t) => t.state === "needs" && inside(t.since) && !waiting.some((q) => q.sid === t.sid));
  return decided.length || ready.length || waiting.length || failed.length || stuck.length ? { since: a.since, end, decided, ready, waiting, failed, stuck } : null;
}

/**
 * Its panel, from its strip, its face or Home (Arun, 2026-11-25: "design the captain tab project pop overs better and more compact"):
 * two views in one popover. Now: what needs you, what's ready, its queue and the last things it did, with its model, today's
 * check-ins and its guard at the foot. Settings, from the gear: how much it does, what it runs on, its limits, its mascot, what it
 * knows, and Remove. Nothing you change once a week sits between you and what's happening.
 */
export function ManagerPanel({ m, p, api: a, onClose, onSettings, headIn }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; onClose: () => void; /** On the Captain's page: its header drawn in the window's band (CaptainPage.tsx), with no close. */ headIn?: HTMLElement | null; /** Its settings, in a modal of their own (2026-11-25: "make it a modal instead"). */ onSettings: () => void }) {
  const header = (
    <header className={`mgr-p-head${headIn ? " in-band" : ""}`}>
      <ManagerFace m={m} size={28} />
      <div className="mgr-p-id">
        <div className="mgr-p-name" title={m.project.folder}>
          {m.project.name}
        </div>
        <span className="mgr-p-state" data-testid="captain-state">
          <CaptainState m={m} />
        </span>
      </div>
      {/* A new conversation, and the ones before it. */}
      {m.on && (
        <MenuButton
          className="mgr-p-gear"
          label="Conversations"
          icon="more"
          end
          compact
          width={260}
          items={() => [
            { label: "New conversation", icon: "plus" as const, disabled: !(m.chat ?? []).length, onSelect: () => void a.newChat(m.id) },
            ...((m.pastChats ?? []).length ? [{ heading: "Earlier" }, ...(m.pastChats ?? []).map((c) => ({ label: c.title, sub: sameDay(c.at, Date.now()) ? clockOf(c.at) : new Date(c.at).toLocaleDateString([], { month: "short", day: "numeric" }), onSelect: () => void a.openChat(m.id, c.at), action: { icon: "trash" as const, label: `Delete "${c.title}"`, onSelect: () => void a.deleteChat(m.id, c.at) } }))] : []),
          ]}
        />
      )}
      <button type="button" className="mgr-p-gear" onClick={onSettings} aria-label="Captain settings" aria-haspopup="dialog" title="Settings">
        <Icon name="sliders" size={15} />
      </button>
      {!headIn && (
        <button type="button" className="mgr-p-gear mgr-p-close" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="x" size={15} />
        </button>
      )}
    </header>
  );
  return (
    <div className={`mgr-panel${m.on ? "" : " is-off"}`} data-testid="manager-panel" data-view="now">
      {headIn ? createPortal(header, headIn) : header}
      {/* No How it works page (2026-11-25: "get rid of this page"): the settings' level cards say it. */}
      <PanelNow m={m} a={a} onClose={onClose} onSettings={onSettings} />
    </div>
  );
}

/** A goal's progress in a line (managers.ts goalLine, here because that file reaches for node modules): "2 of 3 ready · 1 shipped". */
type Goal = NonNullable<Manager["goals"]>[number];
/** 41k, 1.2M, 830: tokens the short way. */
const tokensText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** ~$0.04, <$0.01: about what it cost. */
const usdText = (usd: number) => (usd < 0.01 ? "<$0.01" : `~$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`);
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const sinceText = (at: number) => {
  const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

/**
 * The Captain's window, simple (Arun, 2026-11-25: "we need to simplify and make this so easy for people to use... I don't really get
 * an immediate value out of trying it out", then "make it so easy but so good and understandable"). One column, one loop: you say
 * what should get done, it does it, and it hands it back ready. What needs you is pinned on top; the first thing it says is what it
 * sees and the obvious next step; each thing you ask is a card in the conversation that moves on its own; the box is at the foot.
 */
function PanelNow({ m, a, onClose }: { m: ManagerView; a: ManagersApi; onClose: () => void; onSettings: () => void }) {
  const asks = forYouOf(m);
  const ready = m.on ? (m.ready ?? []) : [];
  const open = (sid?: string) => sid && (dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } })), onClose());
  // Back from Away: the card until Got it, then a one-line divider for as long as this window is open; Show brings the card back.
  const [awayDone, setAwayDone] = useState(false);
  const [awayShown, setAwayShown] = useState(false);
  const back = m.away?.back ? awayOf(m) : null;
  const away = back && (!m.away!.seen || awayShown) ? back : null;
  const awayOn = !!m.away && !m.away.back && m.away.until > Date.now();
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [filter, setFilter] = useState<"all" | "needs" | "working">("all");
  const [page, setPage] = useState(0);
  const run = m.level === "run";
  // Its conversation, less a day's digest line (the greeting says how things stand, live).
  const chat = (m.chat ?? []).filter((c) => !(c.who === "captain" && /^Today in .*:/i.test(c.text.trim())));
  const thinking = (m.chat ?? []).at(-1)?.who === "you";
  const scroller = useRef<HTMLDivElement>(null);
  const finishAllRef = useRef("");
  const msgRef = useRef("");
  msgRef.current = msg;
  // Each thread as it stands now, ready and waiting-on-you from its own record.
  const readySids = new Set(ready.map((r) => r.sid));
  const askSids = new Set(asks.map((x) => x.sid).filter(Boolean));
  const threads = (m.threads ?? []).map((t) => ({ ...t, state: t.state !== "needs" && askSids.has(t.sid) ? ("needs" as const) : (t.state === "idle" || t.state === "stopped") && readySids.has(t.sid) ? ("ready" as const) : t.state }));
  const working = threads.filter((t) => t.state === "working");
  const idle = threads.filter((t) => (t.state === "idle" || t.state === "stopped") && !readySids.has(t.sid));
  const waiting = threads.filter((t) => t.state === "needs");
  // What you asked for, as it stands: goals not given up, a finished one only on the day it finished.
  const goals = (m.goals ?? []).filter((g) => g.status !== "cancelled" && (g.status !== "done" || sameDay(g.at, Date.now())));
  const tasks = m.queue.filter((q) => !q.goal);
  const notices = (m.notices ?? []).filter((n) => n.kind === "risky" || n.kind === "overlap");
  const items: { at: number; key: string; chat?: ChatLine; goal?: Goal; task?: ManagerTask }[] = [
    ...chat.map((c) => ({ at: c.at, key: `c${c.at}${c.who}`, chat: c })),
    ...goals.map((g) => ({ at: g.at + 1, key: `g${g.id}`, goal: g })),
    ...tasks.map((t) => ({ at: t.at, key: `t${t.id}`, task: t })),
  ].sort((x, y) => x.at - y.at);
  useEffect(() => {
    // Its foot, always: the latest answer and what waits on you sit just over the box, as a chat's do (Arun, 2026-11-27: "make
    // sure the answer stuff is pinned to the bottom of the chat and not at the top").
    const el = scroller.current;
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }, [items.length, thinking, m.id, asks.length]);
  const say = (t: string, opts?: SayOpts): Promise<boolean> => {
    const text = t.trim();
    if (!text || sending) return Promise.resolve(false);
    setSending(true);
    return a.say(m.id, text, opts).then((ok) => (setSending(false), ok && setMsg(""), ok));
  };

  // (Before the early return below: hooks run in the same order on and off.) ⌘↵ with nothing in the box finishes the idle threads, as the Finish button's key says.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.key === "Enter" && (e.metaKey || e.ctrlKey)) || !run || !finishAllRef.current || msgRef.current.trim()) return;
      e.preventDefault();
      void say(finishAllRef.current);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  if (!m.on) finishAllRef.current = "";
  if (!m.on)
    return (
      <div className="mgr-off" data-testid="captain-off">
        <p className="mgr-off-t">Off</p>
        <button type="button" className="btn primary small" onClick={() => void a.change(m.id, { on: true })}>
          Turn on
        </button>
      </div>
    );

  // The first thing it says, from how its threads stand now (no tokens): what's left unfinished and the next step. The counts of
  // what's ready and what needs you are the header's chips now, so the line no longer repeats them.
  const unfinished = idle[0] ?? waiting[0];
  const greeting = !threads.length ? `No threads in ${m.project.name} yet.` : null;
  const quoted = (t: { title: string }) => `"${t.title}"`;
  finishAllRef.current = !chat.length && !thinking ? (idle.length > 1 ? `Finish the idle threads: ${idle.slice(0, 6).map((t) => `"${t.title}"`).join(", ")}` : idle[0] ? `Finish "${idle[0].title}"` : "") : "";
  const finishAll = idle.length > 1 ? `Finish the idle threads: ${idle.slice(0, 6).map(quoted).join(", ")}` : unfinished ? `Finish ${quoted(unfinished)}` : "";
  // The threads, what needs you first: waiting on you, ready, working, then idle; newest change first within each.
  const RANK = { needs: 0, ready: 1, working: 2, idle: 3, stopped: 3 } as const;
  const all = [...threads].sort((x, y) => RANK[x.state] - RANK[y.state] || y.since - x.since);
  // The list as filtered (Arun, 2026-11-27: the threads filter, All / Needs you / Working, back above the list).
  const rows = filter === "all" ? all : all.filter((t) => t.state === (filter === "needs" ? "needs" : "working"));
  const ask = asks[Math.min(page, asks.length - 1)];
  // Your last ask, for ↑ in an empty box.
  const lastSaid = [...(m.chat ?? [])].reverse().find((c) => c.who === "you")?.text ?? "";
  const focusBox = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".mgr-one-foot .mgr-composer-ta")?.focus());
  const quick = run ? ["What's left to do?", "Run the tests", "Review today's changes"] : ["What's left to do?", "What changed today?", "Anything risky?"];
  // Each row's second line and its steps, from the Captain's own record of the thread: its question, its checked work, else the
  // last things it did with it (newest last).
  const readyBySid = new Map(ready.map((r) => [r.sid, r]));
  const askBySid = new Map(asks.filter((x) => x.sid).map((x) => [x.sid!, x]));
  const stepsOf = (sid: string, title: string) =>
    m.log.filter((x) => x.sid === sid && x.kind !== "for-you" && x.kind !== "woke").slice(0, 4).reverse().map((x) => stepText(x.text, title));
  const answer = () => {
    const el = scroller.current?.querySelector<HTMLInputElement>(".mgr-dc input");
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.focus();
  };

  return (
    <div className="mgr-one">
      <div className="mgr-one-scroll" ref={scroller}>
        {/* What needs you, pinned: its questions, then work ready to ship, then a risky or overlapping change. */}
        {(asks.length > 0 || ready.length > 0 || notices.length > 0 || away || awayOn || (back && awayDone)) && (
          <section className="mgr-pins" aria-label="For you">
            {away && (
              <AwayCard
                away={away}
                titleOf={(sid) => (m.threads ?? []).find((t) => t.sid === sid)?.title}
                open={open}
                onAnswer={answer}
                onGotIt={() => (setAwayDone(true), setAwayShown(false), void (m.away!.seen || a.awaySeen(m.id)))}
              />
            )}
            {back && !away && awayDone && (
              <div className="mgr-aw-fold">
                <span>
                  While you were away{awayFor(back) ? ` · ${awayFor(back)}` : ""} · {back.waiting.length + back.stuck.length + back.failed.length + back.decided.length + back.ready.length} things
                </span>
                <button type="button" onClick={() => setAwayShown(true)}>
                  Show
                </button>
              </div>
            )}
            {awayOn && (
              <div className="mgr-pin quiet">
                <span className="mgr-pin-t">Away until {clockOf(m.away!.until)}</span>
              </div>
            )}
            {ask && (
              <DecisionCard
                key={ask.at}
                q={ask}
                about={(m.threads ?? []).find((t) => t.sid === ask.sid)?.title}
                pos={Math.min(page, asks.length - 1)}
                of={asks.length}
                onPage={(d) => setPage((p) => Math.max(0, Math.min(asks.length - 1, Math.min(p, asks.length - 1) + d)))}
                onAnswer={(t) => a.answer(m.id, ask.at, t)}
                onDismiss={() => void a.answer(m.id, ask.at, null)}
              />
            )}
            {ready.slice(0, 3).map((r) => {
              const c = checkOf(r);
              return (
                <div key={`${r.sid}:${r.lane}`} className="mgr-pin ready" data-testid="captain-ready" title={r.summary.join(" ")}>
                  <StatusIcon s={c.tone === "failed" ? "failed" : "done"} />
                  <span className="mgr-pin-t">
                    {r.title}
                    <em>
                      <Facts facts={r.facts} />
                      {c.note && ` · ${c.note}`}
                    </em>
                  </span>
                  <StatusChip tone={c.tone}>{c.word}</StatusChip>
                  {/* Put away, on hover only: at rest the card is the mock's, its chip and Review. */}
                  <button type="button" className="mgr-x mgr-hover-x" aria-label={`Put away "${r.title}"`} title="Put away" onClick={() => void a.doneReady(m.id, r.sid, r.lane)}>
                    <Icon name="x" size={11} />
                  </button>
                  {/* The primary button ends the row. */}
                  <button type="button" className="mgr-rc-go sm" onClick={() => open(r.sid)}>
                    Review
                  </button>
                </div>
              );
            })}
            {notices.slice(0, 2).map((n) => (
              <button key={n.id} type="button" className="mgr-pin ask" disabled={!n.sid} onClick={() => open(n.sid)} title={n.text}>
                <span className="mgr-pin-t">{n.text.replace(/"/g, "")}</span>
              </button>
            ))}
          </section>
        )}

        {/* What it sees, and the obvious next step, while you haven't said anything yet. */}
        {/* While the away card is up, it says what needs you; the first line and the list wait until Got it. */}
        {!chat.length && !thinking && !away && (
          <section className="mgr-hello" aria-label="What it sees" data-testid="captain-hello">
            {greeting ? (
              <p>{greeting}</p>
            ) : (
              unfinished && (
                <div className="mgr-hello-row">
                  <p>
                    <b>{idle.length ? `${idle.length} idle` : `${waiting.length} waiting on you`}</b>
                    <span className="mgr-hello-m">{idle.length ? " stopped part way." : ""}</span>
                  </p>
                  {!run && (
                    <button type="button" className="mgr-rc-go sm" disabled={sending} onClick={() => void a.change(m.id, { level: "run" }).then((ok) => ok && say("Finish what's sitting idle"))}>
                      Let it finish them
                    </button>
                  )}
                  {run && (
                    <button type="button" className="mgr-rc-go sm" disabled={sending} title={finishAll} aria-label={idle.length > 2 ? `Finish all ${idle.length}` : idle.length === 2 ? "Finish both" : "Finish it"} aria-keyshortcuts="Meta+Enter" onClick={() => say(finishAll)}>
                      {idle.length > 2 ? `Finish all ${idle.length}` : idle.length === 2 ? "Finish both" : "Finish it"}
                      <kbd className="mgr-kbd-in">⌘↵</kbd>
                    </button>
                  )}
                </div>
              )
            )}
            {all.length > 0 && (
              <div className="mgr-ths-h">
                <span className="mgr-lbl">Threads</span>
                <SegmentedControl
                  size="sm"
                  variant="tray"
                  aria-label="Filter threads"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All", count: all.length },
                    { value: "needs", label: "Needs you", count: all.filter((t) => t.state === "needs").length },
                    { value: "working", label: "Working", count: all.filter((t) => t.state === "working").length },
                  ]}
                />
              </div>
            )}
            {rows.length > 0 && (
              <ul className="mgr-ths" aria-label="Threads">
                {rows.map((t) => {
                  const finish = run && (t.state === "idle" || t.state === "stopped");
                  const steps = stepsOf(t.sid, t.title);
                  const tool = t.tool ? (ENGINE_NAMES[t.tool] ?? t.tool) : "";
                  const st = stepOf(t);
                  const q = askBySid.get(t.sid)?.text;
                  const line =
                    t.state === "needs" ? (q ? askLine(q) : "Waiting on you")
                    : t.state === "ready" && readyBySid.get(t.sid) ? <Facts facts={readyBySid.get(t.sid)!.facts} />
                    : t.state === "working" ? [st?.text ?? steps.at(-1) ?? tool, st?.of ? `step ${st.n} of ${st.of}` : ""].filter(Boolean).join(" · ")
                    : (steps.at(-1) ?? (t.state === "stopped" ? "Stopped part way" : "Idle"));
                  return (
                    <ThreadRow
                      key={t.sid}
                      t={t}
                      line={line}
                      steps={t.state === "working" ? steps : []}
                      canFinish={finish}
                      onOpen={() => open(t.sid)}
                      go={
                        finish ? (
                          <button type="button" className="mgr-th-go" disabled={sending} aria-label={`Finish "${t.title}"`} onClick={() => say(`Finish "${t.title}"`)}>
                            Finish
                          </button>
                        ) : t.state === "needs" && askBySid.has(t.sid) ? (
                          <button type="button" className="mgr-th-go" aria-label={`Answer "${t.title}"`} onClick={answer}>
                            Answer
                          </button>
                        ) : t.state === "ready" ? (
                          <button type="button" className="mgr-th-go" aria-label={`Open "${t.title}"`} onClick={() => open(t.sid)}>
                            Open
                          </button>
                        ) : null
                      }
                    />
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* The conversation: what you said, what it said, and each thing you asked for as a card that moves on its own. */}
        <section className="mgr-talk" aria-label="Conversation" data-testid="captain-chat">
          {items.map((x) =>
            x.chat ? (
              x.chat.who === "you" ? (
                <div key={x.key} className="mgr-msg you" title={clockOf(x.chat.at)}>
                  {x.chat.text}
                </div>
              ) : (
                <div key={x.key} className="mgr-say">
                  <div className="mgr-msg captain md" title={clockOf(x.chat.at)} dangerouslySetInnerHTML={{ __html: md(x.chat.text) }} />
                  <CopyButton text={x.chat.text} />
                </div>
              )
            ) : x.goal ? (
              <GoalCard
                key={x.key}
                g={x.goal}
                m={m}
                open={open}
                onGiveUp={() => void (x.goal!.mission ? a.stopMission(m.id, x.goal!.id) : a.giveUp(m.id, x.goal!.id))}
                onPause={(p) => void a.pauseMission(m.id, x.goal!.id, p)}
                onReview={() => scroller.current?.scrollTo({ top: 0, behavior: "smooth" })}
              />
            ) : (
              <div key={x.key} className="mgr-wait" aria-label="Up next">
                <i className="mgr-goal2-dot" />
                <span title={x.task!.text}>{x.task!.text}</span>
                <em>{run ? "Waiting to start" : "Starts on Run"}</em>
                <button type="button" className="mgr-x" aria-label={`Take "${x.task!.text}" off the queue`} onClick={() => void a.unqueue(m.id, x.task!.id)}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            ),
          )}
          {thinking && (
            <div className="mgr-msg captain thinking">
              <Shine>Thinking…</Shine>
            </div>
          )}
        </section>
      </div>
      <footer className="mgr-one-foot">
        {!chat.length && !thinking && !msg && (
          <div className="mgr-quick" aria-label="Quick asks" role="group">
            {quick.map((q) => (
              <button key={q} type="button" onClick={() => (setMsg(q), focusBox())}>
                <Icon name={QUICK_ICON[q] ?? "message"} size={13} />
                {q}
              </button>
            ))}
          </div>
        )}
        {run ? (
          <RunBox project={m.project.name} rate={(m as { usdPerHour?: number }).usdPerHour} msg={msg} setMsg={setMsg} lastSaid={lastSaid} sending={sending} onSend={(opts) => say(msg, opts)} />
        ) : (
          <div className="composer-box mgr-composer">
            <PromptInput onSubmit={() => void say(msg)} className="prompt">
              <PromptInputBody className="prompt-field relative block">
                <PromptInputTextarea aria-label="Message the Captain" className="mgr-composer-ta" autoFocus value={msg} onChange={(e) => setMsg(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" && !msg && lastSaid) (e.preventDefault(), setMsg(lastSaid));
                    else if (e.key === "Escape" && msg) (e.preventDefault(), e.stopPropagation(), setMsg(""));
                  }} placeholder={`Ask about ${m.project.name}…`} disabled={sending} />
              </PromptInputBody>
              <PromptInputFooter>
                <span />
                <div className="flex items-center gap-1 composer-send">
                  <PromptInputSubmit status={sending ? "submitted" : undefined} disabled={sending || !msg.trim()} aria-label="Send" title={msg.trim() ? "Send" : "Write something first"}>
                    {sending ? undefined : <ArrowUpIcon className="size-4" />}
                  </PromptInputSubmit>
                </div>
              </PromptInputFooter>
            </PromptInput>
          </div>
        )}
        {a.error && <p className="mgr-error">{a.error}</p>}
      </footer>
    </div>
  );
}

/** Copy a reply, said "Copied" for a moment. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mgr-copy"
      aria-label={done ? "Copied" : "Copy"}
      title={done ? "Copied" : "Copy"}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
    >
      <Icon name={done ? "check" : "copy"} size={12} />
    </button>
  );
}


/**
 * How the Captain stands, beside its name: what's for you as chips that say what they are ("1 ready", "1 needs you", not "2 for
 * you"), else what's working, else what it watches.
 */
function CaptainState({ m }: { m: ManagerView }) {
  if (!m.on) return <>Off</>;
  const asks = forYouOf(m);
  const askSids = new Set(asks.map((x) => x.sid));
  const needs = asks.length + (m.threads ?? []).filter((t) => t.state === "needs" && !askSids.has(t.sid)).length;
  const ready = m.ready?.length ?? 0;
  const working = (m.threads ?? []).filter((t) => t.state === "working").length;
  const n = (m.threads ?? []).length;
  if (ready || needs)
    return (
      <>
        {ready > 0 && <StatusChip tone="ready">{ready} ready</StatusChip>}
        {needs > 0 && <StatusChip tone="needs">{needs} needs you</StatusChip>}
      </>
    );
  if (working) return <StatusChip tone="working">{working} working</StatusChip>;
  return <>{n ? `Watching ${n} thread${n === 1 ? "" : "s"}` : "Watching"}</>;
}

/**
 * A Captain's settings, in a modal of their own laid out as the setup sheet (2026-11-25: "make it a modal instead.... because we
 * are cramping so much stuff in one place"): how much it does, what it runs on, its limits, its mascot, what it knows, and Remove.
 * Every change saves as it's made.
 */
export function CaptainSettings({ m, a, open, onClose, onBack }: { m: ManagerView; a: ManagersApi; open: boolean; onClose: () => void; /** Back to its window, when opened from there (2026-11-25: "add a back button to go back to the main captain modal"). */ onBack?: () => void }) {
  const [confirm, confirming] = useConfirm();
  const set = (body: Record<string, unknown>) => void a.change(m.id, body);
  const quiet = QUIET.find((q) => (q.q && m.quiet ? q.q.from === m.quiet.from && q.q.to === m.quiet.to : !q.q && !m.quiet))?.value ?? "none";
  const budgets = [...new Set([20, 40, 80, m.dailyWakes])].sort((x, y) => x - y);
  // What it spent today, from its own turns (2026-11-25: "optimized for cost"): nothing shown on a new day.
  const spend = m.spend && m.spend.day === new Date().toLocaleDateString("en-CA") && m.spend.turns > 0 ? m.spend : null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="mgr-setup mgr-settings max-w-[440px] p-0 gap-0 max-h-[calc(100vh-32px)] overflow-y-auto" data-testid="captain-settings">
        <div className="mgr-s-head">
          {onBack && (
            <button type="button" className="mgr-p-gear mgr-s-back" onClick={onBack} aria-label="Back to the Captain" title="Back">
              <Icon name="arrowLeft" size={15} />
            </button>
          )}
          <ManagerFace m={m} size={36} />
          <div className="min-w-0 flex-1">
            {/* No on switch here: that lives in its popover (2026-11-25: "get rid of the toggle here"). */}
            <DialogTitle className="mgr-s-title">{m.project.name}'s Captain</DialogTitle>
            <DialogDescription className="sr-only">Changes save as you make them.</DialogDescription>
          </div>
        </div>
        {/* Three choices, the rest under More (2026-11-25: "make it so easy but so good and understandable"). */}
        <div className="mgr-s-body">
          <div className="mgr-s-row">
            <span className="mgr-s-kk">
              <b>On</b>
              <span>{m.autonomy ? `Plans and runs work in ${m.project.name}` : `Watches ${m.project.name}'s threads`}</span>
            </span>
            <Switch on={m.on} onChange={(on) => set({ on })} label={m.on ? "Turn the Captain off" : "Turn the Captain on"} />
          </div>
          {/* A Captain v2 goes as far as its autonomy says (its chat's picker sets it too); the level is the older flow's. */}
          {m.autonomy ? (
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>On its own</b>
                <span>{AUTONOMY_PICK.find((x) => x.value === m.autonomy)?.hint}</span>
              </span>
              <Picker stack label="On its own" value={m.autonomy} options={AUTONOMY_PICK} onChange={(autonomy) => set({ autonomy })} />
            </div>
          ) : (
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>Start work by itself</b>
                <span>{m.level === "run" ? "Starts, checks and finishes what you ask" : "Off: it only tells you"}</span>
              </span>
              <Switch on={m.level === "run"} onChange={(v) => set({ level: v ? "run" : "help" })} label="Start work by itself" />
            </div>
          )}
          {m.autonomy && (
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>When a goal is done</b>
                <span>{SHIP_PICK.find((x) => x.value === (m.ship ?? "folder"))?.hint}</span>
              </span>
              <Picker stack label="When a goal is done" value={m.ship ?? "folder"} options={SHIP_PICK} onChange={(ship) => set({ ship })} />
            </div>
          )}
          <div className="mgr-s-row" aria-label="Runs on" role="group">
            <span className="mgr-s-kk">
              <b>Runs on</b>
            </span>
            <RunsOn identity={a.identity} tool={m.tool} model={m.model} stepUp={m.stepUp} onChange={(v) => set(v)} />
          </div>
          <details className="mgr-s-more">
            <summary>
              More settings
              <Icon name="chevronRight" size={13} className="mgr-s-more-chev" />
            </summary>
            {/* Threads, splitting, the queue and tidying are the older flow's; a Captain v2's agents are its own (Checks work still holds). */}
            {!m.autonomy && (
              <div className="mgr-s-row">
                <span className="mgr-s-k">New threads</span>
                <ThreadTool identity={a.identity} value={m.threadTool ?? ""} onChange={(v) => set({ threadTool: v })} />
              </div>
            )}
            <div className="mgr-s-row top">
              <span className="mgr-s-k">{m.autonomy ? "Checks" : "On its own"}</span>
              <div className="mgr-chips" role="group" aria-label="On Run">
                {!m.autonomy && (
                  <>
                    <RunChip on={m.startThreads} onChange={(v) => set({ startThreads: v })} label="Start new threads by itself">
                      Starts threads
                    </RunChip>
                    <RunChip on={m.startQueued} onChange={(v) => set({ startQueued: v })} label="Start the next queued task">
                      Starts queued
                    </RunChip>
                  </>
                )}
                <RunChip on={m.checkWork !== false} onChange={(v) => set({ checkWork: v })} label="Check finished work and send failures back">
                  Checks work
                </RunChip>
                {!m.autonomy && (
                  <>
                    <RunChip on={m.splitWork !== false} onChange={(v) => set({ splitWork: v })} label="Split big tasks into parts">
                      Splits big tasks
                    </RunChip>
                    <RunChip on={m.tidyIdle !== false} onChange={(v) => set({ tidyIdle: v })} label="Stop idle threads' tools and clear finished parts">
                      Tidies idle
                    </RunChip>
                  </>
                )}
              </div>
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-k">Limits</span>
              <div className="mgr-s-limits">
                <Picker label="Daily budget" value={m.dailyWakes} options={budgets.map((n) => ({ value: n, label: m.autonomy ? turnsWord(n) : `${n} check-ins a day` }))} onChange={(n) => set({ dailyWakes: n })} />
                <Picker label="Quiet hours" value={quiet} options={QUIET.map((q) => ({ value: q.value, label: q.label }))} onChange={(v) => set({ quiet: QUIET.find((q) => q.value === v)?.q ?? null })} />
              </div>
            </div>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">Mascot</span>
              <LookPicker value={m.look} onChange={(look) => set({ look })} size={22} />
            </div>
            {spend && (
              <div className="mgr-s-row">
                <span className="mgr-s-k">Today</span>
                <span className="mgr-s-spend">
                  {spend.turns} turn{spend.turns === 1 ? "" : "s"} · {tokensText(spend.tokens)} tokens · {usdText(spend.usd)}
                </span>
              </div>
            )}
          </details>
        </div>
        {a.error && <p className="mgr-error mgr-s-err">{a.error}</p>}
        <div className="mgr-s-foot">
          <span className="mgr-p-guard" title={guardOf(m.ship)}>
            <Icon name="shield" size={12} />
            {m.autonomy ? guardOf(m.ship) : "Never approves PRs, merges, deploys or money"}
          </span>
          <button type="button" className="btn ghost mgr-remove-btn" onClick={() => confirm({ title: `Remove ${m.project.name}'s Captain?`, body: "Its threads keep running. Its queue and what it did go with it.", action: "Remove", onConfirm: () => void a.remove(m.id).then(onClose) })}>
            Remove
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
        {confirming}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A thread's finished work, checked, as a compact result card (memory: result-cards-design): a tile, its title, one facts line,
 * how risky it reads and Review & ship, which opens the thread, where its Ship makes the pull request on your press, never the
 * Captain's. What changed and where to look are on hover.
 */
/** A goal's pieces in order, for its bar and rows: its threads as they stand, then its tasks still waiting to start. */
type Piece = { key: string; state: "shipped" | "ready" | "running" | "stuck" | "waiting" | "quiet"; text: string; sid?: string; tool?: EngineTool };
const PIECE_CHIP: Record<Piece["state"], { word: string; tone?: "working" | "needs" | "ready" }> = { shipped: { word: "Shipped", tone: "ready" }, ready: { word: "Checked", tone: "ready" }, running: { word: "Working", tone: "working" }, stuck: { word: "Stuck", tone: "needs" }, waiting: { word: "Queued" }, quiet: { word: "Quiet" } };
const PIECE_ICON: Record<Piece["state"], StatusTone> = { shipped: "done", ready: "done", running: "working", stuck: "needs", waiting: "queued", quiet: "idle" };
/** A thread's name in sentence case, as the Captain's plan may write it lower case ("tidy the readme"). */
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
// The goal as its crew, the Captain over its threads (agent-viz/places.tsx, Agent Crew), and a thread as its monitor: loaded when opened.
const VizCrew = lazy(() => import("./components/agent-viz/places.js").then((x) => ({ default: x.CaptainCrew })));
const VizMonitor = lazy(() => import("./components/agent-viz/places.js").then((x) => ({ default: x.ThreadMonitor })));

/**
 * What you asked for, as a card that moves on its own (2026-11-27 polish, then the wave-1 audit). A mission reads top to bottom: its
 * round as its chip ("Round 2 of 6"), how long it has run, a More menu; what done means; its threads in their stages, each with
 * its step and clock while it works; the judge's rounds as squares with the latest reason; the budget as a meter, Pause and Open
 * threads at its foot. Done: "Done in N rounds", the threads checked folded with their diffs, "Ready for you to merge", Diff
 * and Review.
 */
function GoalCard({ g, m, open, onGiveUp, onPause, onReview }: { g: Goal; m: ManagerView; open: (sid?: string) => void; onGiveUp: () => void; onPause: (pause: boolean) => void; onReview: () => void }) {
  const ms = g.mission;
  const [folded, setFolded] = useState(true);
  const [crew, setCrew] = useState(false);
  const byId = new Map((m.threads ?? []).map((t) => [t.sid, t]));
  const readyBy = new Map((m.ready ?? []).map((r) => [r.sid, r]));
  const pieces: Piece[] = [
    // Each thread as it stands now (its live state over the goal's record): running only while it really runs, waiting on you as stuck.
    ...g.threads.map((t) => {
      const live = byId.get(t.sid);
      const state: Piece["state"] = t.state === "shipped" || t.state === "ready" ? t.state : live?.state === "working" ? "running" : live?.state === "needs" || t.state === "stuck" ? "stuck" : live ? "quiet" : t.state;
      return { key: t.sid, state, text: live?.title || t.task, sid: t.sid, ...(live?.tool ? { tool: live.tool } : {}) } as Piece;
    }),
    ...m.queue.filter((q) => q.goal === g.id).map((q) => ({ key: q.id, state: "waiting" as const, text: q.text })),
  ];
  const count = (st: Piece["state"]) => pieces.filter((x) => x.state === st).length;
  const done = g.status === "done";
  // Its state from its pieces as they stand, so it never says Working with nothing running.
  const roundWord = ms ? `${ms.rounds} round${ms.rounds === 1 ? "" : "s"}` : "";
  const chip: { word: string; tone?: "working" | "needs" | "ready" } =
    done ? { word: ms ? `Done in ${roundWord}` : "Done", tone: "ready" }
    : g.status === "cancelled" ? { word: "Given up" }
    : ms?.paused ? { word: "Paused" }
    : count("stuck") ? { word: "Stuck", tone: "needs" }
    : g.status === "ready" ? { word: "Ready for you", tone: "ready" }
    : ms && (g.status === "checking" || count("running")) ? { word: `Round ${Math.min(ms.rounds + 1, MISSION_ROUNDS)} of ${MISSION_ROUNDS}`, tone: "working" }
    : count("running") || !pieces.length ? { word: pieces.length ? "Working" : "Planning", tone: "working" }
    : count("waiting") ? { word: "Waiting to start" }
    : { word: "Quiet" };
  const live = !!ms && !done && g.status !== "cancelled";
  const note = ms && (ms.paused ? `Paused: ${ms.paused.why}.` : ms.verdict && (done || !ms.verdict.met) && ms.verdict.why ? `Round ${Math.max(1, ms.rounds)}: ${ms.verdict.met ? "done" : "not yet"}. ${sentence(ms.verdict.why)}` : (ms.reports[0]?.text ?? ""));
  // How long it has run: live while it does, the whole of it once done.
  const ended = done ? (ms?.verdict?.at ?? g.at) : 0;
  // The judge's rounds so far, one square each: not yet in red, the one that said done in green, the one being judged outlined.
  const judged = !!ms && (ms.rounds > 0 || g.status === "checking" || !!ms.verdict);
  // Done, only the rounds it took; while it runs, the empty ones it has left too.
  const rounds = ms ? Array.from({ length: done ? ms.rounds : Math.max(MISSION_ROUNDS, ms.rounds + 1) }, (_, i) => (i < ms.rounds ? (done && i === ms.rounds - 1 ? "yes" : "no") : i === ms.rounds && g.status === "checking" ? "now" : "")) : [];
  const now = pieces.filter((x) => x.state !== "waiting");
  const after = pieces.filter((x) => x.state === "waiting");
  // The change's size across its threads, from their checked work.
  const diffs = g.threads.map((t) => /(\d+) files? \+(\d+) [−-](\d+)/.exec(readyBy.get(t.sid)?.facts ?? "")).filter(Boolean) as RegExpExecArray[];
  const sum = (i: number) => diffs.reduce((n, d) => n + Number(d[i]), 0);
  const review = g.threads.find((t) => readyBy.has(t.sid))?.sid ?? g.threads[0]?.sid;
  const row = (x: Piece) => {
    const r = x.sid ? readyBy.get(x.sid) : undefined;
    const t = x.sid ? byId.get(x.sid) : undefined;
    const st = t ? stepOf(t) : null;
    const after = x.state === "waiting" ? (m.queue.find((q) => q.id === x.key) as { startsWhen?: string } | undefined)?.startsWhen : undefined;
    const sub = r ? <Facts facts={r.facts} /> : x.state === "running" ? [st?.text ?? (x.tool ? (ENGINE_NAMES[x.tool] ?? x.tool) : ""), st?.of ? `step ${st.n} of ${st.of}` : ""].filter(Boolean).join(" · ") : after ? after : x.tool ? (ENGINE_NAMES[x.tool] ?? x.tool) : "";
    const chipOf = r && (x.state === "ready" || x.state === "shipped") ? checkOf(r) : null;
    return (
      <button key={x.key} type="button" className={`mgr-goal2-row ${x.state}`} disabled={!x.sid} onClick={() => open(x.sid)} title={x.text}>
        <StatusIcon s={PIECE_ICON[x.state]} />
        <span className="mgr-goal2-rt">{sentence(x.text)}</span>
        {sub && (
          <span className="mgr-goal2-rl">
            {x.tool && x.state !== "waiting" && <EngineMark tool={x.tool} size={11} />}
            <span>{sub}</span>
          </span>
        )}
        <span className="mgr-goal2-rs">
          {/* While it works, its clock in place of a chip (the mock); checked work says how its check went. */}
          {x.state === "running" && t?.since ? <LiveClock since={t.since} className="mgr-clock" /> : <StatusChip tone={chipOf?.tone ?? PIECE_CHIP[x.state].tone}>{x.state === "shipped" ? "Shipped" : (chipOf?.word ?? PIECE_CHIP[x.state].word)}</StatusChip>}
        </span>
      </button>
    );
  };
  const firstLive = g.threads.find((t) => byId.get(t.sid)?.state === "working")?.sid ?? g.threads[0]?.sid;
  return (
    <div className={`mgr-goal2${done ? " done" : ""}`} data-testid="captain-goal">
      <div className="mgr-goal2-top">
        {ms && (
          <span className="mgr-goal2-lbl">
            <Glyph d={TARGET} size={14} />
            Mission
          </span>
        )}
        <StatusChip tone={chip.tone}>{chip.word}</StatusChip>
        <span className="mgr-goal2-acts">
          {ms && (live ? <LiveClock since={g.at} className="mgr-clock" /> : done ? <span className="mgr-clock">{runClock(ended - g.at)}</span> : null)}
          {pieces.length > 0 && !done && (
            <button type="button" className="mgr-x" aria-pressed={crew} aria-label={crew ? "Show the threads as a list" : "Show the crew"} title={crew ? "As a list" : "The crew: the Captain over its threads"} onClick={() => setCrew(!crew)}>
              <Icon name={crew ? "list" : "diagram"} size={11} />
            </button>
          )}
          {(!ms || live) && (
            <MenuButton
              label={`More for "${g.title}"`}
              icon="more"
              end
              compact
              items={() => [
                ...(live ? [{ label: ms!.paused ? "Carry on" : "Pause", icon: (ms!.paused ? "play" : "pause") as IconName, onSelect: () => onPause(!ms!.paused) }] : []),
                ...(firstLive ? [{ label: "Open threads", icon: "external" as IconName, onSelect: () => open(firstLive) }] : []),
                { label: ms ? "Stop the mission" : "Give up", icon: "x" as IconName, danger: true, onSelect: onGiveUp },
              ]}
            />
          )}
        </span>
      </div>
      <b className="mgr-goal2-t">{g.title}</b>
      {ms && (
        <p className="mgr-mission-done" title={ms.done}>
          <span className="mgr-dw-l">
            <Icon name="check" size={12} />
            Done when
          </span>{" "}
          <span className="mgr-dw-t">{ms.done}</span>
        </p>
      )}
      {!pieces.length && <p className="mgr-goal2-plan">Planning the threads…</p>}
      {pieces.length > 0 && !done && crew && (
        <Suspense fallback={null}>
          <VizCrew m={m} goal={g.id} open={(sid) => open(sid)} />
        </Suspense>
      )}
      {pieces.length > 0 && !done && !crew && (
        <div className="mgr-goal2-rows">
          {after.length > 0 && ms && <div className="mgr-stage">Now · {ms.parallel} at once</div>}
          {now.map(row)}
          {after.length > 0 && <div className="mgr-stage">After</div>}
          {after.map(row)}
        </div>
      )}
      {(judged || note) && (
        <div className={judged ? "mgr-judge" : ""}>
          {judged && (
            <div className="mgr-judge-top">
              <b>Done?</b>
              <span className="mgr-rounds" aria-label={`${ms!.rounds} round${ms!.rounds === 1 ? "" : "s"} judged`}>
                {rounds.map((r, i) => (
                  <span key={i} className={`mgr-rd ${r}`}>
                    {r === "yes" ? <Icon name="check" size={10} /> : r === "no" ? <Icon name="x" size={10} /> : null}
                  </span>
                ))}
              </span>
              {/* The judge's answer on the squares' line, the reason under it (the mock's judge block). */}
              {done ? <StatusChip tone="ready">Yes</StatusChip> : g.status === "checking" ? <StatusChip tone="working">Judging</StatusChip> : <span className="mgr-judge-max">up to {MISSION_ROUNDS} rounds</span>}
            </div>
          )}
          {note && <p className="mgr-mission-note">{note}</p>}
        </div>
      )}
      {done && pieces.length > 0 && (
        <div className={`mgr-goal2-fold${folded ? "" : " open"}`}>
          <button type="button" className="mgr-goal2-foldb" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            <StatusIcon s="done" />
            <span className="mgr-goal2-foldt">
              <b>
                {pieces.length} thread{pieces.length === 1 ? "" : "s"} checked
              </b>
              {diffs.length > 0 && (
                <em>
                  {sum(1)} file{sum(1) === 1 ? "" : "s"} · <span className="mgr-add">+{sum(2)}</span> <span className="mgr-del">−{sum(3)}</span>
                </em>
              )}
            </span>
            <span className="mgr-goal2-caretb">
              <Icon name="chevronDown" size={13} className="mgr-goal2-caret" />
            </span>
          </button>
          {!folded && (
            <ol className="mgr-goal2-done">
              {pieces.map((x) => {
                const d = x.sid ? /(\d+) files? \+(\d+) [−-](\d+)/.exec(readyBy.get(x.sid)?.facts ?? "") : null;
                return (
                  <li key={x.key}>
                    <StatusIcon s="done" />
                    <span>{sentence(x.text)}</span>
                    {d && (
                      <span className="mgr-goal2-d">
                        <span className="mgr-add">+{d[2]}</span> <span className="mgr-del">−{d[3]}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      {(ms || g.status === "ready") && (
        <div className="mgr-goal2-f">
          {ms && ms.budgetUsd > 0 ? (
            <div className="mgr-budget">
              <div>
                <span>{done ? "Spent" : "Budget"}</span>
                <span className="mgr-budget-n">
                  <b>${ms.spent.toFixed(2)}</b> of ${ms.budgetUsd}
                </span>
              </div>
              <div className={`mgr-meter${ms.spent >= ms.budgetUsd ? " bad" : ms.spent >= ms.budgetUsd * 0.8 ? " warn" : ""}`}>
                <i style={{ width: `${Math.min(100, (ms.spent / ms.budgetUsd) * 100)}%` }} />
              </div>
            </div>
          ) : ms && ms.spent >= 0.01 ? (
            <span className="mgr-goal2-guard">Spent ${ms.spent.toFixed(2)}</span>
          ) : null}
          {ms && <span className="mgr-goal2-guard">{done && !ms.prs ? "Ready for you to merge" : `${ms.prs ? "Opens PRs" : "No PRs"} · never merges`}</span>}
          {live && g.status !== "ready" && (
            <>
              <button type="button" className="mgr-rc-no sm mgr-ib-btn" aria-label={ms!.paused ? `Carry on "${g.title}"` : `Pause "${g.title}"`} title={ms!.paused ? "Carry on" : "Pause: nothing new starts"} onClick={() => onPause(!ms!.paused)}>
                <Icon name={ms!.paused ? "play" : "pause"} size={12} />
                {ms!.paused ? "Carry on" : "Pause"}
              </button>
              {firstLive && (
                <button type="button" className="mgr-rc-go sm" onClick={() => open(firstLive)}>
                  Open threads
                </button>
              )}
            </>
          )}
          {g.status === "ready" && (
            <button type="button" className="mgr-rc-go sm" onClick={onReview}>
              Review what&apos;s ready
            </button>
          )}
          {done && review && (
            <>
              <button type="button" className="mgr-rc-no sm mgr-ib-btn" title="Open its changes" onClick={() => open(review)}>
                <Icon name="code" size={12} />
                Diff
              </button>
              <button type="button" className="mgr-rc-go sm" onClick={() => open(review)}>
                Review
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}


type MissionDraft = { parallel: number; setParallel: (n: number) => void; budget: number; setBudget: (n: number) => void; prs: boolean; setPrs: (v: boolean) => void; /** About what its threads spend an hour, when the record has it. */ rate?: number | undefined };
const BUDGETS = [0, 5, 10, 25, 50, 100];

/**
 * Its settings as snug rounded-square menus, each with its icon, the chosen value in ink (2026-11-27 polish): threads at once as a
 * 1 to 4 control inside its menu, a budget whose menu says what happens at the line, and pull requests on or off.
 */
function MissionPills({ d }: { d: MissionDraft }) {
  return (
    <>
      <MenuButton
        className={`mgr-mtb${d.parallel !== 2 ? " set" : ""}`}
        label="Threads at once"
        above
        width={232}
        items={() => [
          { heading: "Threads at once" },
          {
            node: (
              <SegmentedControl size="sm" variant="tray" fullWidth aria-label="Threads at once" value={String(d.parallel)} onChange={(v) => d.setParallel(Number(v))} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))} className="mgr-seg-kit" />
            ),
            height: 40,
          },
          { node: <p className="mgr-mpop-f">Each thread works in its own copy of the project.</p>, height: 34 },
        ]}
      >
        <Glyph d={LAYERS} />
        <b>{d.parallel}</b> at once
        <Icon name="chevronDown" size={12} className="mgr-mtb-caret" />
      </MenuButton>
      <MenuButton
        className={`mgr-mtb${d.budget ? " set" : ""}`}
        label="Budget"
        above
        width={196}
        items={() => [
          { heading: "Pause at" },
          ...BUDGETS.map((usd) => ({ label: usd ? `$${usd}` : "No budget", checked: d.budget === usd, onSelect: () => d.setBudget(usd), ...(usd && d.rate ? { hint: hoursFor(usd, d.rate) } : {}) })),
          { node: <p className="mgr-mpop-f">At the line it pauses and asks you.</p>, height: 34 },
        ]}
      >
        <Glyph d={COIN} />
        {d.budget ? (
          <>
            <b>${d.budget}</b> budget
          </>
        ) : (
          "No budget"
        )}
        <Icon name="chevronDown" size={12} className="mgr-mtb-caret" />
      </MenuButton>
      <button type="button" className={`mgr-mtb${d.prs ? " set" : ""}`} aria-pressed={d.prs} onClick={() => d.setPrs(!d.prs)} title={d.prs ? "Checked work becomes a pull request" : "Finished work waits for you to ship"}>
        <Icon name="gitPullRequest" size={13} />
        {d.prs ? "Opens PRs" : "No PRs"}
      </button>
    </>
  );
}

/** The mock's three glyphs, which the app's icon set doesn't have: stacked layers (threads at once), a coin (budget), info. */
const TARGET = "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 8.6a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2z";
const LAYERS = "M8 2.5 14 5.5 8 8.5 2 5.5zM2 8.2l6 3 6-3M2 10.9l6 3 6-3";
const COIN = "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM9.8 6.2C9.5 5.6 8.8 5.2 8 5.2c-1 0-1.8.6-1.8 1.4 0 1.9 3.6 1 3.6 2.9 0 .8-.8 1.4-1.8 1.4-.9 0-1.6-.4-1.9-1.1M8 4.2v1M8 10.9v1";
const INFO = "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.3v3.6M8 5.2v.01";
const Glyph = ({ d, size = 13 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

/** About how long a budget lasts at its rate: "about 2 hours". */
const hoursFor = (usd: number, rate: number) => {
  const h = Math.max(1, Math.round(usd / rate));
  return `about ${h} hour${h === 1 ? "" : "s"}`;
};

/** What it will do with work, in one short line that follows the settings. */
const missionSentence = (d: MissionDraft) =>
  `${d.parallel === 1 ? "One thread" : `${d.parallel} threads at once`}, each in its own copy. Checked, then judged done.${d.prs ? " Opens pull requests." : ""}${d.budget ? ` Pauses at $${d.budget}.` : ""} Never merges.`;

export type SayOpts = { done?: string; parallel?: number; budgetUsd?: number; prs?: boolean };

/**
 * A Run Captain's box: one way in (Arun, 2026-11-27: "Yeah also let's look at one way in"). What you write is what you want; work
 * becomes a mission it owns until done is true (missions.ts), a question is answered. "Done when" is yours to say or leave: left
 * empty, the Captain says its own and the card shows it. Its settings are the box's pills, and the line under "Done when" says what
 * it will do, once you've said what done means. Enter sends; Shift+Enter is a new line; ↑ in an empty box brings back your last.
 */
function RunBox({ project, rate, msg, setMsg, lastSaid, sending, onSend }: { project: string; rate?: number | undefined; msg: string; setMsg: (v: string) => void; lastSaid: string; sending: boolean; onSend: (opts: SayOpts) => Promise<boolean> }) {
  const [done, setDone] = useState("");
  const [parallel, setParallel] = useState(2);
  const [budget, setBudget] = useState(0);
  const [prs, setPrs] = useState(false);
  const d: MissionDraft = { parallel, setParallel, budget, setBudget, prs, setPrs, rate };
  const send = () => {
    if (!msg.trim() || sending) return;
    void onSend({ ...(done.trim() ? { done: done.trim() } : {}), parallel, ...(budget ? { budgetUsd: budget } : {}), ...(prs ? { prs } : {}) }).then((ok) => ok && setDone(""));
  };
  return (
    <form
      className="composer-box mgr-mbox"
      aria-label="Message the Captain"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        className="mgr-mbox-ask mgr-composer-ta"
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send());
          else if (e.key === "ArrowUp" && !msg && lastSaid) (e.preventDefault(), setMsg(lastSaid));
          else if (e.key === "Escape" && msg) (e.preventDefault(), e.stopPropagation(), setMsg(""));
        }}
        placeholder={`What should get done in ${project}?`}
        aria-label="Message the Captain"
        rows={2}
        autoFocus
        disabled={sending}
      />
      <label className="mgr-mbox-done">
        <Icon name="check" size={12} />
        <span>Done when</span>
        <input
          value={done}
          onChange={(e) => setDone(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), send())}
          placeholder="optional: it says its own"
          aria-label="What done looks like"
          disabled={sending}
        />
      </label>
      {done.trim() && (
        <p className="mgr-mbox-sum">
          <Glyph d={INFO} size={12} />
          {missionSentence(d)}
        </p>
      )}
      <div className="mgr-mbox-foot">
        <MissionPills d={d} />
        {/* Quiet until there's something to send, then the primary key with its shortcut beside it (Enter sends here). */}
        {msg.trim() && !sending && <kbd className="mgr-mbox-kbd">↵</kbd>}
        <button type="submit" className={`mgr-mbox-send${msg.trim() ? " on" : ""}`} aria-label="Send" title={msg.trim() ? "Send (↵)" : "Write something first"} disabled={sending || !msg.trim()}>
          {sending ? <span className="spinner" /> : <ArrowUpIcon className="size-4" />}
        </button>
      </div>
    </form>
  );
}

/** How long you were away, the short way ("2h 14m"); nothing for under a minute. */
const awayFor = (a: { since: number; end: number }) => {
  const t = elapsed(a.since, a.end);
  return t === "now" ? "" : t;
};

/** Its time away as a small line: a soft bump per event, its mark on the peak in the event's colour. */
function AwayLine({ w }: { w: NonNullable<ReturnType<typeof awayOf>> }) {
  const span = Math.max(1, w.end - w.since);
  const marks = [
    ...w.decided.map((x) => ({ at: x.at, c: "done" })),
    ...w.ready.map((x) => ({ at: x.at, c: "done" })),
    ...w.failed.map((x) => ({ at: x.at, c: "failed" })),
    ...w.waiting.map((x) => ({ at: x.at, c: "needs" })),
    ...w.stuck.map((x) => ({ at: x.since, c: "needs" })),
  ].map((e) => ({ ...e, x: Math.min(1, Math.max(0, (e.at - w.since) / span)) }));
  const N = 60;
  const ys = Array.from({ length: N + 1 }, (_, i) => marks.reduce((y, e) => y + Math.exp(-(((i / N - e.x) / 0.06) ** 2)), 0));
  const top = Math.max(1, ...ys);
  const Y = (v: number) => 40 - (v / top) * 30;
  const pts = ys.map((v, i) => `${(i / N) * 300},${Y(v).toFixed(1)}`);
  const at = (x: number) => Y(ys[Math.round(x * N)] ?? 0);
  return (
    <div className="mgr-aw-line">
      <svg viewBox="0 0 300 46" preserveAspectRatio="none" aria-hidden>
        <path d={`M0,46 L${pts.join(" L")} L300,46 Z`} className="mgr-aw-area" />
        <path d={`M${pts.join(" L")}`} className="mgr-aw-stroke" vectorEffect="non-scaling-stroke" />
        {marks.map((e, i) => (
          <ellipse key={i} cx={e.x * 300} cy={at(e.x)} rx={3.6} ry={3} className={`mgr-aw-dot ${e.c}`} />
        ))}
      </svg>
      <div className="mgr-aw-ax">
        <span>{clockOf(w.since)}</span>
        <span>{clockOf(w.end)}</span>
      </div>
    </div>
  );
}

/**
 * While you were away, as one card (2026-11-27 polish, then the wave-1 audit, as the mock): how long you were gone and the counts
 * (needs you, failed, done), the time away as a small line with a mark per event, then a row each with its one action: Decide,
 * Open, Change. "N things" and Got it at its foot; Got it folds it to a line.
 */
function AwayCard({ away: w, titleOf, open, onAnswer, onGotIt }: { away: NonNullable<ReturnType<typeof awayOf>>; titleOf: (sid?: string) => string | undefined; open: (sid?: string) => void; onAnswer: () => void; onGotIt: () => void }) {
  const needs = w.waiting.length + w.stuck.length;
  const doneN = w.decided.length + w.ready.length;
  const counts = [needs > 0 && { k: "needs", t: `${needs} needs you` }, w.failed.length > 0 && { k: "failed", t: `${w.failed.length} failed` }, doneN > 0 && { k: "ready", t: `${doneN} done` }].filter(Boolean) as { k: string; t: string }[];
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const ghost = (label: string, sid: string | undefined, title?: string) =>
    sid ? (
      <button type="button" className="mgr-aw-ghost" onClick={() => open(sid)} {...(title ? { title } : {})}>
        {label}
      </button>
    ) : null;
  const rows: { key: string; s: StatusTone; t: string; l: ReactNode; act: ReactNode }[] = [
    ...w.waiting.map((x) => ({ key: `w${x.at}`, s: "needs" as const, t: titleOf(x.sid) ?? "A question", l: x.text, act: <button type="button" className="mgr-rc-go sm" onClick={onAnswer}>Decide</button> })),
    ...w.stuck.map((t) => ({ key: `s${t.sid}`, s: "needs" as const, t: t.title, l: "Waiting on you", act: <button type="button" className="mgr-rc-go sm" onClick={() => open(t.sid)}>Decide</button> })),
    ...w.failed.map((x) => ({ key: `f${x.at}`, s: "failed" as const, t: titleOf(x.sid) ?? "A thread", l: stepText(x.text, titleOf(x.sid) ?? ""), act: x.sid ? <button type="button" className="mgr-rc-no sm" onClick={() => open(x.sid)}>Open</button> : null })),
    ...w.decided.map((x) => ({ key: `d${x.at}`, s: "done" as const, t: titleOf(x.sid) ?? "Decided for you", l: cap(x.text.replace(/^Decided:\s*/i, "")), act: ghost("Change", x.sid, "Open its thread to change it") })),
    ...w.ready.map((r) => ({ key: `r${r.sid}${r.lane}`, s: "done" as const, t: r.title, l: <Facts facts={r.facts} />, act: ghost("Open", r.sid) })),
  ].slice(0, 5);
  const things = needs + w.failed.length + doneN;
  return (
    <div className="mgr-pin mgr-aw" data-testid="captain-away">
      <div className="mgr-aw-h">
        <b>While you were away</b>
        {awayFor(w) && <span className="mgr-aw-for">{awayFor(w)}</span>}
        <span className="mgr-aw-cnts">
          {counts.map((c) => (
            <span key={c.t} className={`mgr-aw-cnt ${c.k}`}>
              <i aria-hidden />
              {c.t}
            </span>
          ))}
        </span>
      </div>
      <AwayLine w={w} />
      <div className="mgr-aw-rows">
        {rows.map((r) => (
          <div key={r.key} className="mgr-aw-row">
            <StatusIcon s={r.s} />
            <span className="mgr-pin-t">
              {r.t}
              <em>{r.l}</em>
            </span>
            {r.act}
          </div>
        ))}
      </div>
      <div className="mgr-aw-f">
        <span className="mgr-aw-n">
          {things} thing{things === 1 ? "" : "s"}
        </span>
        <button type="button" className="mgr-rc-no sm" onClick={onGotIt}>
          <Icon name="check" size={12} />
          Got it
        </button>
      </div>
    </div>
  );
}

/** The question's choices and its recommended one, when the Captain sends them (not every question has any). */
type Choices = { options?: string[]; recommended?: number };
/** A thread's current step and how far along, when its record has them. */
type StepData = { step?: { text?: string; n?: number; of?: number } | string; stepText?: string; stepIndex?: number; stepTotal?: number };
function stepOf(t: object): { text?: string; n: number; of: number } | null {
  const x = t as StepData;
  const st = typeof x.step === "object" && x.step ? x.step : null;
  const text = (typeof x.step === "string" ? x.step : st?.text) ?? x.stepText;
  const of = st?.of ?? x.stepTotal ?? 0;
  const n = st?.n ?? (x.stepIndex !== undefined ? x.stepIndex + 1 : 0);
  return text || of ? { ...(text ? { text } : {}), n, of } : null;
}
/** A needs-you row's line: why it asks and what, "Check failed twice · asks what to try". */
const askLine = (q: string) => {
  const why = /still fails its check/i.test(q) ? "Check failed twice" : /still stuck/i.test(q) ? "Stuck after a hint" : /done in parts/i.test(q) ? "Couldn't do it in parts" : "";
  const what = askShort(q);
  return why ? `${why} · asks ${what.replace(/\?$/, "")}` : what.charAt(0).toUpperCase() + what.slice(1);
};
const UNDO_MS = 4000;

/**
 * One of its questions for you as a decision card (2026-11-27 polish, the mock's): what needs you and which thread, "1 of N" with
 * a pager when there are more, the question, its answers numbered with the recommended one marked when the Captain offers them
 * (keys 1 to 4), and a last row for your own words. Answering folds it to "Answered … · Undo" for a moment before it's passed
 * on, so Undo is real. Later folds it to a line; put away (x) shows on hover.
 */
function DecisionCard({ q, about, pos, of, onPage, onAnswer, onDismiss }: { q: ManagerAct & Choices; about: string | undefined; pos: number; of: number; onPage: (d: number) => void; onAnswer: (t: string) => Promise<boolean>; onDismiss: () => void }) {
  const [reply, setReply] = useState("");
  const [later, setLater] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const own = useRef<HTMLInputElement>(null);
  const opts = (q.options ?? []).filter((x) => typeof x === "string" && x.trim()).slice(0, 3);
  // The answer waiting out its Undo; closing the window meanwhile sends it then, never drops it.
  const pending = useRef<string | null>(null);
  const pick = (t: string) => {
    const text = t.trim();
    if (!text || sent !== null) return;
    setSent(text);
    pending.current = text;
    timer.current = setTimeout(() => ((pending.current = null), void onAnswer(text).then((ok) => ok || setSent(null))), UNDO_MS);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void onAnswer(pending.current);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Keys 1 to 4 answer it while the focus isn't in a field: a numbered answer, or the last one for your own words.
  useEffect(() => {
    if (later || sent !== null || !opts.length) return;
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest("input, textarea, [contenteditable]")) return;
      const n = Number(e.key);
      if (!(n >= 1 && n <= opts.length + 1)) return;
      e.preventDefault();
      if (n <= opts.length) pick(opts[n - 1]!);
      else own.current?.focus();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  if (sent !== null)
    return (
      <div className="mgr-ask mgr-dc folded">
        <StatusIcon s="done" />
        <span className="mgr-dc-fold">
          Answered <b>{sent}</b>
        </span>
        <button type="button" className="mgr-dc-later" onClick={() => (timer.current && clearTimeout(timer.current), (pending.current = null), setSent(null))}>
          <Icon name="rewind" size={12} />
          Undo
        </button>
      </div>
    );
  if (later)
    return (
      <div className="mgr-ask mgr-dc folded">
        <StatusIcon s="needs" />
        <span className="mgr-dc-fold">{of === 1 ? "1 question for later" : `${of} questions for later`}</span>
        <button type="button" className="mgr-dc-later" onClick={() => setLater(false)}>
          Open
        </button>
      </div>
    );
  return (
    <div className="mgr-ask mgr-dc">
      <div className="mgr-dc-h">
        <StatusChip tone="needs">Needs you</StatusChip>
        {about && <span className="mgr-dc-about">{about}</span>}
        <span className="mgr-dc-pager">
          {of > 1 && (
            <button type="button" className="mgr-dc-pg" aria-label="Previous question" disabled={pos === 0} onClick={() => onPage(-1)}>
              <Icon name="chevronRight" size={12} className="mgr-flip" />
            </button>
          )}
          <span className="mgr-dc-n">
            {pos + 1} of {of}
          </span>
          {of > 1 && (
            <button type="button" className="mgr-dc-pg" aria-label="Next question" disabled={pos === of - 1} onClick={() => onPage(1)}>
              <Icon name="chevronRight" size={12} />
            </button>
          )}
        </span>
        <button type="button" className="mgr-dc-later" onClick={() => setLater(true)}>
          Later
        </button>
        <button type="button" className="mgr-x mgr-hover-x" aria-label="Put this question away" title="Put away" onClick={onDismiss}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <p className="mgr-ask-q">{q.text}</p>
      {opts.length > 0 && (
        <div className="mgr-dc-opts" role="group" aria-label="Answers">
          {opts.map((o, i) => (
            <button key={i} type="button" className="mgr-dc-o" aria-keyshortcuts={String(i + 1)} onClick={() => pick(o)}>
              <kbd className="mgr-dc-num">{i + 1}</kbd>
              <span>{o}</span>
              {q.recommended === i && <span className="mgr-dc-rec">Recommended</span>}
            </button>
          ))}
        </div>
      )}
      <form
        className={`mgr-ask-form${opts.length ? " numbered" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          pick(reply);
        }}
      >
        {opts.length > 0 && <kbd className="mgr-dc-num">{opts.length + 1}</kbd>}
        <input ref={own} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={opts.length ? "Something else…" : "Your answer"} aria-label="Your answer" />
        <button type="submit" className={`mgr-send${reply.trim() ? " on" : ""}`} aria-label="Send your answer" disabled={!reply.trim()}>
          <Icon name="arrowUp" size={12} />
        </button>
      </form>
    </div>
  );
}

/** One of its log lines about a thread, said without the thread's own name, which its row says already. */
const stepText = (text: string, title: string) => {
  const t = text.split(`"${title}"`).join("it").replace(/^Mission "[^"]*": /, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** How a ready thread's check went, as its chip says it: checked, failed, risky or not checked. */
function checkOf(r: { facts: string; risk: string }): { tone: "ready" | "needs" | "failed"; word: string; note?: string } {
  if (/^Check failed/i.test(r.facts)) return { tone: "failed", word: "Check failed" };
  if (r.risk === "high") return { tone: "failed", word: "Risky" };
  if (/^Checked/i.test(r.facts)) return { tone: "ready", word: "Checked" };
  return { tone: "needs", word: "Unchecked", note: /couldn't check/i.test(r.facts) ? "couldn't check" : "no test to run" };
}

/** A thread's change in a few words, its lines added and taken out in their state colours: "2 files · +31 −12". */
function Facts({ facts }: { facts: string }) {
  const d = /(\d+ files?) \+(\d+) [−-](\d+)/.exec(facts);
  if (!d) return <>{facts.replace(/^(Checked|Done)\s*·\s*/i, "")}</>;
  return (
    <>
      {d[1]} · <span className="mgr-add">+{d[2]}</span> <span className="mgr-del">−{d[3]}</span>
    </>
  );
}

/** An icon for each quick ask, so the row reads at a glance. */
const QUICK_ICON: Record<string, IconName> = { "What's left to do?": "list", "Run the tests": "play", "Review today's changes": "search", "What changed today?": "clock", "Anything risky?": "shield" };

type RowState = "needs" | "ready" | "working" | "idle" | "stopped";
const ROW_ICON: Record<RowState, StatusTone> = { needs: "needs", ready: "done", working: "working", idle: "idle", stopped: "idle" };

/**
 * A thread in the window's list (2026-11-27 polish): its status icon, its title, a second line saying where it is, and one chip or
 * its age on the right. Hovered, its one action (Finish, Answer, Open) takes the chip's place; a working thread opens to the last
 * things the Captain did with it.
 */
function ThreadRow({ t, line, steps, canFinish, go, onOpen }: { t: { sid: string; title: string; state: RowState; since: number; tool?: EngineTool | undefined }; line: ReactNode; steps: string[]; canFinish: boolean; go: ReactNode; onOpen: () => void }) {
  const [shown, setShown] = useState(false);
  const working = t.state === "working";
  return (
    <li className={`mgr-th ${t.state}${canFinish ? " can-finish" : ""}${go ? " has-go" : ""}${shown ? " open" : ""}`}>
      <button type="button" className="mgr-th-open" onClick={onOpen} title={`Open "${t.title}"`}>
        <StatusIcon s={ROW_ICON[t.state]} />
        <span className="mgr-th-t">{t.title}</span>
        <span className="mgr-th-l">
          {/* Only the working row names its tool (the mock): where it's at work, not where it last was. */}
          {working && t.tool && (
            <span className="mgr-th-tool" title={ENGINE_NAMES[t.tool] ?? t.tool}>
              <EngineMark tool={t.tool} size={12} />
            </span>
          )}
          <span className="mgr-th-lt">{line}</span>
        </span>
      </button>
      <span className="mgr-th-r">
        <span className="mgr-th-s">
          {working ? t.since > 0 ? <LiveClock since={t.since} className="mgr-clock" /> : <StatusChip tone="working">Working</StatusChip> : t.state === "needs" ? <StatusChip tone="needs">Needs you</StatusChip> : t.state === "ready" ? <StatusChip tone="ready">Ready</StatusChip> : t.since > 0 ? sinceText(t.since) : ""}
        </span>
        {go}
        {working && (
          <button type="button" className="mgr-th-caret" aria-expanded={shown} aria-label={shown ? "Hide steps" : "Show steps"} onClick={() => setShown(!shown)}>
            <Icon name="chevronDown" size={13} />
          </button>
        )}
      </span>
      {shown && (
        <div className="mgr-th-more">
          <ol className="mgr-th-steps" aria-label="Recent steps">
            {steps.map((x, i) => (
              <li key={i}>
                <StatusIcon s="done" />
                <span>{x}</span>
              </li>
            ))}
            <li className="now">
              <StatusIcon s="working" />
              <span>{typeof line === "string" && line && line !== (t.tool ? ENGINE_NAMES[t.tool] : "") ? line : "Working"}</span>
              {t.since > 0 && <LiveClock since={t.since} className="mgr-clock" />}
            </li>
          </ol>
          <div className="mgr-th-acts">
            <button type="button" className="mgr-rc-no sm" onClick={onOpen}>
              Open thread
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** A tool's model for a Captain when none is picked: Haiku on Claude Code, else its first named model (as the server's captainModel). */
const defaultModel = (tool: EngineTool) => (tool === "claude" ? "haiku" : (ENGINE_MODEL_INFO[tool].find((m) => m.id !== "auto")?.id ?? "auto"));
const defaultStepUp = (tool: EngineTool) => (tool === "claude" ? "sonnet" : "");

/**
 * The coding tool a Captain runs on, its model, and the model it steps up to when something is hard (Arun, 2026-11-24: "be able
 * to select models from various coding tools and stuff as well for the captain"). Tools are the ones ready on this computer; models
 * are that tool's own list, as the composer's pill reads it. Friday's Auto isn't offered: a Captain runs on one model it can count.
 */
/**
 * What the threads a Captain starts run on (2026-11-25: "what agents it will select for use... only selecting Codex"): Auto, the
 * best fit for each task weighed by what you use in the project and what is already busy (managers pickThreadTool), or one of
 * the coding tools ready here.
 */
function ThreadTool({ identity, value, onChange }: { identity: Identity; value: EngineTool | ""; onChange: (v: EngineTool | "") => void }) {
  const { state } = useMachine(identity);
  const ready = state.tools.filter((f) => f.path && !f.unavailable && f.loggedIn !== false).map((f) => f.tool as EngineTool);
  const tools = value && !ready.includes(value) ? [value, ...ready] : ready;
  return (
    <Picker
      label="New threads run on"
      heading="New threads it starts run on"
      value={value}
      options={[{ value: "", label: "Auto", text: "Auto: best fit for each task", hint: "your habit here, what is busy" }, ...tools.map((t) => ({ value: t, label: ENGINE_NAMES[t] ?? t, mark: <EngineMark tool={t} size={13} /> }))]}
      onChange={(v) => onChange(v as EngineTool | "")}
    />
  );
}

function RunsOn({ identity, tool, model, stepUp, onChange }: { identity: Identity; tool: EngineTool; model: string; stepUp: string; onChange: (v: { tool?: EngineTool; model?: string; stepUp?: string }) => void }) {
  const { state } = useMachine(identity);
  const listed = useEngineModelInfo(tool, identity).filter((x) => x.id !== "auto");
  const models = listed.some((x) => x.id === model) ? listed : [{ id: model, label: model }, ...listed];
  const ups = stepUp && !models.some((x) => x.id === stepUp) ? [{ id: stepUp, label: stepUp }, ...models] : models;
  const hasLatest = ups.some((x) => (x as { group?: string }).group === "Latest");
  // The coding tool and its model as the app's one picker, as on the new-session page and a teammate's (2026-11-25: "use the
  // default model picker instead of the two seperate pickers for coding tool and model"): its own coding tools only, never
  // Friday Code (own={[]}), and the step-up beside it.
  const toolState = (t: EngineTool) => {
    const f = state.tools.find((x) => x.tool === t);
    return {
      disabled: !!f && (!f.path || !!f.unavailable),
      absent: !!f && !f.path,
      ready: !!f?.path && !f.unavailable && f.loggedIn !== false,
      hint: f ? (f.path ? (f.unavailable ? "not here yet" : f.loggedIn === false ? "sign in" : "ready") : "not installed") : "…",
    };
  };
  return (
    <div className="mgr-runs">
      <div className="mgr-runs-pick">
        <AgentModelPicker
          engine={tool}
          onEngine={(t) => t && t !== tool && onChange({ tool: t, model: defaultModel(t), stepUp: defaultStepUp(t) })}
          model={model}
          onModel={(v) => v && v !== "auto" && onChange(v === stepUp ? { model: v, stepUp: "" } : { model: v })} // a Captain runs on one model, never smart routing
          fridayModelId=""
          onFridayModel={() => {}}
          fridayName=""
          plan="free"
          identity={identity}
          toolState={toolState}
          own={[]}
        />
      </div>
      {/* The step-up, dense (2026-11-25: "design this better too information dense"): the tool's latest models only, each with
          its one word, and an older one only when it's the one picked; the field says "Steps up to …". */}
      <Picker above label="When it's unsure, it steps up to" heading="When it's unsure" value={stepUp === model ? "" : stepUp} options={[{ value: "", label: "Stays on its model", text: "Stays on its model" }, ...ups.filter((x) => x.id !== model && (!hasLatest || (x as { group?: string }).group === "Latest" || x.id === stepUp)).map((x) => ({ value: x.id, label: x.label, text: `Steps up to ${x.label}`, hint: wordOf((x as { blurb?: string }).blurb ?? "", x.id) }))]} onChange={(v) => onChange({ stepUp: v })} className="mgr-runs-up" />
    </div>
  );
}

/** Ten mascots to pick from: each seed makes its own colour, shape and eyes (teammate-face.tsx). */
const LOOKS = ["cap:ada", "cap:bo", "cap:cy", "cap:dee", "cap:eli", "cap:fay", "cap:gus", "cap:hal", "cap:ivy", "cap:jo"];
const shuffled = () => `cap:${Math.random().toString(36).slice(2, 9)}`;

/**
 * Picking a Captain's mascot (Arun, 2026-11-24: "be able to customize the managers mascot too"): ten to choose from and Shuffle
 * for a new one; the one it has now leads the row when it isn't one of the ten.
 */
function LookPicker({ value, onChange, size = 26 }: { value: string; onChange: (look: string) => void; size?: number }) {
  const row = LOOKS.includes(value) ? LOOKS : [value, ...LOOKS.slice(0, 9)];
  return (
    <div className="mgr-looks" role="radiogroup" aria-label="Its mascot">
      {row.map((l, i) => (
        <button key={l} type="button" role="radio" aria-checked={value === l} aria-label={`Mascot ${i + 1}`} className={value === l ? "on" : ""} onClick={() => onChange(l)}>
          <ManagerFace m={{ look: l, on: true }} size={size} />
        </button>
      ))}
      <button type="button" className="mgr-shuffle" onClick={() => onChange(shuffled())} aria-label="Shuffle for a new mascot" title="Shuffle">
        <Icon name="refresh" size={13} />
      </button>
    </div>
  );
}
/** How far a Captain v2 goes on its own, in its chat picker's words (CaptainChat AUTONOMY). */
const AUTONOMY_PICK: { value: "ask" | "merge" | "run"; label: string; hint: string }[] = [
  { value: "ask", label: "Ask first", hint: "Each plan waits for you to press Start." },
  { value: "merge", label: "Ask before bringing in", hint: "Starts on its own, asks before bringing the crew's work into your folder." },
  { value: "run", label: "Run to ready", hint: "Starts and finishes on its own; you review what's ready." },
];
/**
 * How far a finished goal goes on its own (Arun, 2026-11-28: "user chooses"): only the crew's files, never merged. A push or a pull
 * request only when the check of the whole didn't fail; otherwise it stops at the branch.
 */
const SHIP_PICK: { value: "folder" | "branch" | "push" | "pr"; label: string; hint: string }[] = [
  { value: "folder", label: "Leave in my folder", hint: "Finished work waits in your folder, uncommitted, for you to look over." },
  { value: "branch", label: "Commit to a branch", hint: "Commits the crew's files to a friday/ branch on this Mac. Nothing leaves it." },
  { value: "push", label: "Push the branch", hint: "Commits to a friday/ branch and pushes it. No pull request." },
  { value: "pr", label: "Open a pull request", hint: "Commits to a friday/ branch, pushes it and opens a pull request. Never merges." },
];
/** What it may never do, and what it does with its crew's work (pre-release review P0-6), as far as its settings let it go. */
const guardOf = (ship?: string) =>
  ship === "pr"
    ? "Never merges, approves pull requests, deploys or spends money. Opens a pull request with only its crew's files when a goal is finished and its checks pass."
    : ship === "push"
      ? "Never opens or approves pull requests, deploys or spends money. Pushes a friday/ branch with only its crew's files when a goal is finished and its checks pass."
      : ship === "branch"
        ? "Never pushes, opens or approves pull requests, deploys or spends money. Commits only its crew's files to a friday/ branch on this Mac when a goal is finished."
        : "Never pushes, opens or approves pull requests, deploys or spends money. Brings its crew's work into your folder, uncommitted, when you allow it.";
const GUARD = guardOf();
const turnsWord = (n: number) => `Up to ${n} Captain turns a day`;
const QUIET: { value: string; label: string; q: { from: number; to: number } | null }[] = [
  { value: "none", label: "No quiet hours", q: null },
  { value: "22-8", label: "Quiet 10 PM – 8 AM", q: { from: 22 * 60, to: 8 * 60 } },
  { value: "23-7", label: "Quiet 11 PM – 7 AM", q: { from: 23 * 60, to: 7 * 60 } },
];

/**
 * The sheet that sets up a Captain for one of the sidebar's projects (Arun, 2026-11-24: "more compact and simplier… selecting
 * project doesnt work"): the project and its face in one line, how much it does, and its limits as three small choices.
 */
export function ManagerSetup({ api: a, projects, initial, open, onClose }: { api: ManagersApi; projects: readonly { name: string; folder: string }[]; initial?: string; open: boolean; onClose: () => void }) {
  const free = projects.filter((p) => !managerFor(a.managers, p));
  const [project, setProject] = useState("");
  const [look, setLook] = useState(LOOKS[0]!);
  // On by default: what you ask, it starts, checks and finishes; it never ships or merges (2026-11-25: "immediate value").
  const [level] = useState<ManagerLevel>("run");
  // A new Captain is a Captain v2 (pre-release review P1-13): how far it goes on its own, Ask before bringing in unless you pick.
  const [autonomy, setAutonomy] = useState<"ask" | "merge" | "run">("merge");
  const [startThreads] = useState(true);
  const [startQueued] = useState(true);
  const [checkWork, setCheckWork] = useState(true);
  const [splitWork] = useState(true);
  const [tidyIdle] = useState(true);
  const [daily, setDaily] = useState(40);
  const [quiet, setQuiet] = useState("none");
  const [tool, setTool] = useState<EngineTool>("claude");
  const [model, setModel] = useState("haiku");
  const [stepUp, setStepUp] = useState("sonnet");
  const [busy, setBusy] = useState(false);
  // Picked once as it opens, never again while it's open: the project list is rebuilt on every render of the sidebar, and an
  // effect on it put the first project back after each pick (2026-11-24: "selecting project doesnt work").
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setProject(initial && free.some((p) => p.name === initial) ? initial : (free[0]?.name ?? ""));
    wasOpen.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = free.find((p) => p.name === project) ?? free[0];
  const turnOn = () => {
    if (!pick) return;
    setBusy(true);
    void a.create({ folder: pick.folder, name: pick.name, look, level, autonomy, startThreads, startQueued, checkWork, splitWork, tidyIdle, dailyWakes: daily, quiet: QUIET.find((q) => q.value === quiet)?.q ?? null, tool, model, stepUp }).then(async (ok) => {
      setBusy(false);
      if (!ok) return;
      onClose();
      // Turned on, its page opens (where you tell it what to do).
      const got = await api<{ managers?: ManagerView[] }>(a.identity, "/api/managers").catch(() => null);
      const made = got?.managers && managerFor(got.managers, pick);
      if (made) dispatchEvent(new CustomEvent("friday:captain", { detail: made.id }));
    });
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="mgr-setup max-w-[420px] p-0 gap-0 max-h-[calc(100vh-32px)] overflow-y-auto" data-testid="manager-setup">
        <div className="mgr-s-head">
          <ManagerFace m={{ look, on: true }} size={36} />
          <div className="min-w-0">
            <DialogTitle className="mgr-s-title">New Captain</DialogTitle>
            <DialogDescription className="mgr-s-sub">Plans the work and runs a crew of agents on it.</DialogDescription>
          </div>
        </div>
        {!pick ? (
          <p className="mgr-s-none">{projects.length ? "Every project in your sidebar has a Captain. Start a thread in another folder to set one up there." : "Pick a project folder first: start a thread in a folder, then set up its Captain here."}</p>
        ) : (
          <div className="mgr-s-body">
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>Project</b>
              </span>
              <Picker label="Project" value={pick.name} options={free.map((p) => ({ value: p.name, label: p.name, sub: p.folder }))} onChange={setProject} className="mgr-s-pick" />
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>On its own</b>
                <span>{AUTONOMY_PICK.find((x) => x.value === autonomy)?.hint}</span>
              </span>
              <Picker label="On its own" value={autonomy} options={AUTONOMY_PICK} onChange={setAutonomy} />
            </div>
            <div className="mgr-s-row" aria-label="Runs on" role="group">
              <span className="mgr-s-kk">
                <b>Runs on</b>
              </span>
              <RunsOn
                identity={a.identity}
                tool={tool}
                model={model}
                stepUp={stepUp}
                onChange={(v) => {
                  if (v.tool) setTool(v.tool);
                  if (v.model !== undefined) setModel(v.model);
                  if (v.stepUp !== undefined) setStepUp(v.stepUp);
                }}
              />
            </div>
            <details className="mgr-s-more">
              <summary>
              More settings
              <Icon name="chevronRight" size={13} className="mgr-s-more-chev" />
            </summary>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">Mascot</span>
              <LookPicker value={look} onChange={setLook} size={22} />
            </div>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">Checks</span>
                <div className="mgr-chips" role="group" aria-label="Checks">
                  <RunChip on={checkWork} onChange={setCheckWork} label="Check finished work and send failures back">
                    Checks work
                  </RunChip>
                </div>
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-k">Limits</span>
              <div className="mgr-s-limits">
                <Picker label="Daily budget" value={daily} options={[20, 40, 80].map((n) => ({ value: n, label: turnsWord(n) }))} onChange={setDaily} />
                <Picker label="Quiet hours" value={quiet} options={QUIET.map((q) => ({ value: q.value, label: q.label }))} onChange={setQuiet} />
              </div>
            </div>
            </details>
          </div>
        )}
        {a.error && <p className="mgr-error mgr-s-err">{a.error}</p>}
        <div className="mgr-s-foot">
          <span className="mgr-p-guard">
            <Icon name="shield" size={12} />
            {GUARD}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!pick || busy} onClick={turnOn}>
            Turn on
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Captain's window and its settings, as ManagerPopover opens them (loaded with the first one opened). */
export function CaptainWindow({ m, p, api, open, onOpenChange, sheet, setSheet }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; open: boolean; onOpenChange: (v: boolean) => void; sheet: boolean; setSheet: (v: boolean) => void }) {
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Esc with something typed in the box clears the box (its own keydown); only an empty box closes the window.
          onEscapeKeyDown={(e) => { const t = document.activeElement; if (t instanceof HTMLTextAreaElement && t.classList.contains("mgr-composer-ta") && t.value) e.preventDefault(); }}
          className="mgr-pop mgr-modal mgr-one-modal max-w-[540px] sm:max-w-[540px] w-[calc(100vw-48px)] p-0 gap-0">
          <DialogTitle className="sr-only">{m.project.name}'s Captain</DialogTitle>
          <DialogDescription className="sr-only">What it's doing, what it needs from you, and a box to talk to it.</DialogDescription>
          <ManagerPanel m={m} p={p} api={api} onClose={() => onOpenChange(false)} onSettings={() => (onOpenChange(false), setSheet(true))} />
        </DialogContent>
      </Dialog>
      <CaptainSettings m={m} a={api} open={sheet} onClose={() => setSheet(false)} onBack={() => (setSheet(false), onOpenChange(true))} />
    </>
  );
}

/**
 * Running now, from the folded Captains' chip (the polish mock, Arun 2026-11-27: "the same thing you sent in the artifact"): every
 * thread a Captain has at work, with its progress ring, where it is and how far ("3/5"), and pause or carry on when it's a
 * mission's; then each that needs you, with Open. A row opens its Captain's window. Loaded with the first opening, not the sidebar.
 */
export function RunningNow({ managers, api: a, onOpen, onClose, anchor }: { managers: ManagerView[]; api: ManagersApi; onOpen: (x: ManagerView) => void; onClose: () => void; anchor: RefObject<HTMLElement | null> }) {
  const rows: ReactNode[] = [];
  let count = 0;
  // A row opens that thread's monitor under it (Agent Monitor); the monitor's Open is the Captain's window.
  const [mon, setMon] = useState<string | null>(null);
  const monitor = (x: ManagerView, sid: string, extra: { onPause?: () => void; paused?: boolean } = {}) =>
    mon === sid && (
      <Suspense key={`m${sid}`} fallback={null}>
        <VizMonitor m={x} sid={sid} progress={progressOf(x, sid)} onOpen={() => onOpen(x)} {...extra} />
      </Suspense>
    );
  for (const x of managers) {
    const name = x.project.name;
    // A Captain v2's own work (captain-v2.md: its agents are lanes in its hidden session, not threads): its turn, its agents at work
    // or waiting, its questions, a plan for your Start and failed steps. Each row opens its page. Never the project's threads.
    if (x.autonomy) {
      const v = x as LiveView;
      const plan = v.plans?.find((p) => p.id === v.now?.plan);
      const pr = plan?.status === "running" ? plan.progress : undefined;
      const row = (key: string, icon: ReactNode, title: string, sub: string, end?: ReactNode) => (
        count++,
        rows.push(
          <div key={key} className="mgr-run-row" data-testid="running-row">
            <button type="button" className="mgr-run-open" onClick={() => onOpen(x)} title={`Open ${name}'s Captain`}>
              {icon}
              <span className="mgr-run-t">{title}</span>
              <span className="mgr-run-s">
                {name} · {sub}
              </span>
            </button>
            {end}
          </div>,
        )
      );
      const needs = (
        <Badge tone="warning" size="sm">
          Needs you
        </Badge>
      );
      if (v.captain?.state === "running") row(`c${x.id}`, <ProgressRing size={16} frac={pr?.total ? pr.done / pr.total : null} />, "Captain", v.captain.activity || "Planning");
      for (const a of v.agents ?? [])
        if (a.status === "working") row(`a${a.id}`, <BlobFace seed={a.look} size={16} />, `${a.name} · ${a.role}`, a.activity || "Working", pr ? <span className="mgr-run-n">{`${Math.min(pr.done + 1, pr.total)}/${pr.total}`}</span> : undefined);
        else if (a.status === "needs") row(`a${a.id}`, <BlobFace seed={a.look} size={16} />, `${a.name} · ${a.role}`, "Waiting on you", needs);
      if (plan?.status === "draft") row(`d${plan.id}`, <StatusIcon s="needs" />, "A plan waits for your Start", `${plan.tasks.length} steps`, needs);
      const failed = (plan?.tasks ?? []).filter((t) => t.status === "failed");
      // A failed step's own "For you" is the failure, said once (managers.ts captainNow).
      for (const q of forYouOf(x).filter((q) => !failed.some((t) => t.lane && t.lane === q.lane))) row(`q${q.at}`, <StatusIcon s="needs" />, askShort(q.text), "Asks you", needs);
      for (const t of failed) row(`f${t.id}`, <StatusIcon s="failed" />, `${v.agents?.find((a) => a.id === t.agent)?.name ?? t.role}'s step failed`, t.result || "Failed");
      continue;
    }
    for (const t of (x.threads ?? []).filter((t) => t.state === "working")) {
      const prog = progressOf(x, t.sid);
      const g = x.goals?.find((g) => g.mission && g.status !== "done" && g.status !== "cancelled" && g.threads.some((y) => y.sid === t.sid));
      const paused = !!g?.mission?.paused;
      count++;
      rows.push(
        <div key={`w${t.sid}`} className="mgr-run-row">
          <button type="button" className="mgr-run-open" aria-expanded={mon === t.sid} onClick={() => setMon(mon === t.sid ? null : t.sid)} title="How it's going">
            <ProgressRing size={16} frac={prog ? prog.done / prog.of : null} />
            <span className="mgr-run-t">{t.title}</span>
            <span className="mgr-run-s">
              {name} · {paused ? "paused" : t.tool ? (ENGINE_NAMES[t.tool] ?? t.tool) : "working"}
            </span>
          </button>
          {prog && <span className="mgr-run-n">{`${Math.min(prog.done + 1, prog.of)}/${prog.of}`}</span>}
          {g && (
            <button type="button" className="mgr-run-ib" aria-label={paused ? `Carry on "${g.title}"` : `Pause "${g.title}"`} title={paused ? "Carry on" : "Pause: nothing new starts"} onClick={() => void a.pauseMission(x.id, g.id, !paused)}>
              <Icon name={paused ? "play" : "pause"} size={13} />
            </button>
          )}
        </div>,
        monitor(x, t.sid, g ? { onPause: () => void a.pauseMission(x.id, g.id, !paused), paused } : {}),
      );
    }
    const asks = forYouOf(x);
    const waiting = (x.threads ?? []).filter((t) => t.state === "needs" && !asks.some((q) => q.sid === t.sid));
    for (const q of [...asks.map((q) => ({ key: `q${q.at}`, sid: undefined as string | undefined, title: (x.threads ?? []).find((t) => t.sid === q.sid)?.title ?? "A question", line: q.text })), ...waiting.map((t) => ({ key: `n${t.sid}`, sid: t.sid as string | undefined, title: t.title, line: "waiting on you" }))])
      count++,
      rows.push(
        <div key={q.key} className="mgr-run-row">
          <button type="button" className="mgr-run-open" aria-expanded={q.sid ? mon === q.sid : undefined} onClick={() => (q.sid ? setMon(mon === q.sid ? null : q.sid) : onOpen(x))} title={q.sid ? "How it's going" : `Open ${name}'s Captain`}>
            <StatusIcon s="needs" />
            <span className="mgr-run-t">{q.title}</span>
            <span className="mgr-run-s">
              {name} · {q.line}
            </span>
          </button>
          <Badge tone="warning" size="sm">
            Needs you
          </Badge>
          <Button variant="secondary" size="sm" onClick={() => onOpen(x)}>
            Open
          </Button>
        </div>,
        q.sid && monitor(x, q.sid),
      );
  }
  return (
    <Popover open onClose={onClose} anchor={anchor} side="bottom" align="start" width={anchor.current?.offsetWidth ?? 280} unstyled focusOnOpen={false} className="mgr-run-pop" aria-label="Running now">
      <div className="mgr-run-h">
        Running now <span>{count}</span>
      </div>
      {rows}
    </Popover>
  );
}
