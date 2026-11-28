// Agent Monitor (affectUI Pro, rebuilt by hand from its public preview; SPEC agent-monitor): one agent at work as a card. Its step
// now with a clock (and what it has cost, when that's known), a strip of where the time went, the steps it finished with each
// tool's mark (a press opens what a step did), the exact command when it needs your OK with Allow and Decline from the keyboard;
// folded, a small bar of the tools it used. Every change is a soft swap: a new step rolls up into the well, a finished one drops
// into the top of the list.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Shine } from "../../shine.js";
import { Tile, clockOf, statusWord, tookOf, usd, useTick, type VizStatus, type VizTool } from "./viz-parts.js";
import "./agent-viz.css";

export interface MonitorStep {
  id: string;
  text: string;
  /** How long it took. */
  ms: number;
  tool: VizTool;
  failed?: boolean;
  /** What its info card says: a line of what it did, and the command or path it ran on. */
  note?: string;
  code?: string;
  /** When it started, from the run's start, for the info card's "Started". */
  at?: number;
}

export interface AgentMonitorProps {
  name: string;
  subtitle?: string;
  avatar: ReactNode;
  status: VizStatus;
  words?: Partial<Record<VizStatus, string>>;
  /** What it has cost so far, when that's known. */
  cost?: number;
  /** The step it is on: a new `key` rolls it into the well. */
  current?: { key: string; text: string; tool: VizTool; since: number };
  /** Held on your OK: what for and the exact command, with your two answers (none: shown, answered where it lives). */
  ask?: { title: string; command: string; tool?: VizTool; since?: number; onAllow?: () => void; onDecline?: () => void; allow?: string };
  /** Finished steps, newest first. */
  steps: MonitorStep[];
  /** Steps done of its plan, when it has one. */
  progress?: { done: number; total: number };
  /** When the run began, for each step's "Started". */
  started?: number;
  onPause?: () => void;
  pauseLabel?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  onLog?: () => void;
  logLabel?: string;
  /** Starts folded to its bar. */
  folded?: boolean;
  /** What folded shows: "bar", a small bar of the tools it used; "head", its top part (name, state, what it's on, the strip),
   *  opening to its steps and actions (a session's agent list, Arun 2026-11-27). */
  collapse?: "bar" | "head";
  /** Beside the fold button in the head: the agent's own controls (its ⋯ menu, Answer). */
  headEnd?: ReactNode;
  /** Wraps the state chip, e.g. in the button that opens what proves it's done. */
  pillWrap?: (pill: ReactNode) => ReactNode;
  label?: string;
  className?: string;
}

const ICON = {
  fold: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5L6 4.5l2-2M4 9.5l2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  pause: (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.25 3v6M7.75 3v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  cancel: (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  out: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 3.5h4v4M8.5 3.5L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  enter: (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M9.5 3v3.2c0 .7-.6 1.3-1.3 1.3H3M5 5.5L3 7.5l2 2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  x: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
};

/** The step's words and clock rolling into the well: the last one leaves upward, blurred, as the new one rises in. */
function useRoll<T extends { key: string }>(v: T | undefined, ms = 380): { now: T | undefined; was: T | undefined } {
  const [was, setWas] = useState<T | undefined>(undefined);
  const last = useRef(v);
  useEffect(() => {
    if (last.current && v && last.current.key !== v.key) {
      setWas(last.current);
      const t = setTimeout(() => setWas(undefined), ms);
      last.current = v;
      return () => clearTimeout(t);
    }
    last.current = v;
  }, [v?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { now: v, was };
}

export function AgentMonitor(p: AgentMonitorProps) {
  const [folded, setFolded] = useState(!!p.folded);
  const [info, setInfo] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const live = p.status === "working" || p.status === "needs";
  const now = useTick(live);
  const roll = useRoll(p.current);
  const card = useRef<HTMLElement>(null);
  const word = statusWord(p.status, p.words);
  const asking = p.status === "needs" && p.ask;
  const head = p.collapse === "head";
  // Folded to its head, it opens by itself when it needs you: the OK is inside.
  useEffect(() => {
    if (head && asking) setFolded(false);
  }, [head, !!asking]); // eslint-disable-line react-hooks/exhaustive-deps

  const keys = (e: KeyboardEvent) => {
    if (!asking || (e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "Enter" && p.ask!.onAllow) (e.preventDefault(), p.ask!.onAllow());
    else if (e.key === "Escape" && p.ask!.onDecline) (e.preventDefault(), p.ask!.onDecline());
  };

  // The strip: each finished step's share of the time, the step under way growing as it runs, a cap for where it stands.
  const curMs = p.current ? Math.max(0, now - p.current.since) : 0;
  const segs = [...p.steps].reverse().map((s) => ({ id: s.id, ms: s.ms, kind: s.failed ? "bad" : "done" }));
  if (p.current && p.status === "working") segs.push({ id: "now", ms: curMs, kind: "now" });
  const total = segs.reduce((n, s) => n + s.ms, 0) || 1;

  if (folded && !head) {
    const tools = [...new Map([...[...p.steps].reverse().map((s) => [s.tool.id, s] as const), ...(p.current ? [[p.current.tool.id, { id: "now", text: p.current.text, ms: curMs, tool: p.current.tool }] as const] : [])]).values()];
    return (
      <section className={`viz viz-mon-bar ${p.className ?? ""}`} aria-label={p.label ?? `${p.name}: ${word}`}>
        <button type="button" className="viz-mon-barb" onClick={() => setFolded(false)} aria-expanded={false} title="Open">
          <Tile size={26}>{p.avatar}</Tile>
          <span className="viz-mon-bar-n">{p.name}</span>
        </button>
        <span className="viz-mon-stack">
          {tools.map((s, i) => (
            <span key={s.tool.id} className={i === tools.length - 1 ? "viz-mon-st on" : "viz-mon-st"} style={{ zIndex: i } as CSSProperties}>
              <Tile size={24}>{s.tool.mark}</Tile>
              <span className="viz-mon-tip" role="tooltip">
                <b>{s.text}</b>
                <span>
                  {s.tool.label}
                  {s.ms ? ` · ${tookOf(s.ms)}` : ""}
                </span>
              </span>
            </span>
          ))}
        </span>
        {p.current && live && <span className="viz-mon-bar-c">{clockOf(curMs)}</span>}
      </section>
    );
  }

  return (
    <section ref={card} className={`viz viz-mon ${p.className ?? ""}`} data-s={p.status} data-folded={(head && folded) || undefined} aria-label={p.label ?? `${p.name}: ${word}`} tabIndex={asking ? 0 : undefined} onKeyDown={keys}>
      <header className="viz-mon-head">
        <Tile size={26}>{p.avatar}</Tile>
        <span className="viz-nm">
          <span className="viz-name">{p.name}</span>
          {p.subtitle && <span className="viz-model">{p.subtitle}</span>}
        </span>
        {p.cost != null && (
          <Shine on={p.status === "working"} className="viz-mon-cost">
            {usd(p.cost)}
          </Shine>
        )}
        {(p.pillWrap ?? ((x: ReactNode) => x))(
          <span className="viz-pill" data-s={p.status}>
            <i aria-hidden="true" />
            <span key={p.status} className="viz-swap">
              {word}
            </span>
          </span>,
        )}
        {head ? (
          <button type="button" className="viz-x lg" aria-expanded={!folded} aria-label={folded ? `Open ${p.name}'s steps` : "Fold to the top"} title={folded ? "Open its steps" : "Fold"} onClick={() => setFolded(!folded)}>
            {ICON.fold}
          </button>
        ) : (
          <button type="button" className="viz-x lg" aria-label="Fold away" title="Fold away" onClick={() => setFolded(true)}>
            {ICON.fold}
          </button>
        )}
        {p.headEnd}
      </header>

      {asking ? (
        <div className="viz-mon-well ask">
          <span className="viz-mon-roll in" key={`ask:${p.ask!.command}`}>
            {p.ask!.tool && <Tile size={24}>{p.ask!.tool.mark}</Tile>}
            <span className="viz-mon-step">{p.ask!.title}</span>
            <code className="viz-mon-cmd" title={p.ask!.command}>
              {p.ask!.command}
            </code>
          </span>
          {p.ask!.since != null && <span className="viz-mon-clock">{clockOf(now - p.ask!.since)}</span>}
        </div>
      ) : roll.now ? (
        <div className="viz-mon-well">
          {roll.was && (
            <span className="viz-mon-roll out" key={`was:${roll.was.key}`} aria-hidden="true">
              <Tile size={24}>{roll.was.tool.mark}</Tile>
              <span className="viz-mon-step">{roll.was.text}</span>
            </span>
          )}
          <span className="viz-mon-roll in" key={roll.now.key}>
            <Tile size={24}>{roll.now.tool.mark}</Tile>
            <Shine on={p.status === "working"} className="viz-mon-step">
              {roll.now.text}
            </Shine>
          </span>
          {p.status === "working" && <span className="viz-mon-clock">{clockOf(curMs)}</span>}
        </div>
      ) : null}

      {segs.length > 0 && (
        <span className="viz-mon-strip" data-end={p.status} aria-hidden="true">
          {segs.map((s) => (
            <i
              key={s.id}
              data-k={s.kind}
              data-hot={hot ? (hot === s.id ? "on" : "off") : undefined}
              style={{ flexGrow: Math.max(s.ms / total, 0.012) } as CSSProperties}
              onMouseEnter={() => s.id !== "now" && setHot(s.id)}
              onMouseLeave={() => setHot(null)}
            />
          ))}
          {(p.status === "working" || p.status === "needs") && <b className="viz-mon-cap" />}
        </span>
      )}

      {!folded && p.steps.length > 0 && (
        <ol className="viz-mon-list" data-more={p.steps.length > 3 || undefined}>
          {p.steps.map((s) => (
            <li key={s.id} data-hot={hot ? (hot === s.id ? "on" : "off") : undefined} onMouseEnter={() => setHot(s.id)} onMouseLeave={() => setHot(null)}>
              <button type="button" className="viz-mon-row" aria-expanded={info === s.id} aria-label={`${s.text} – details`} onClick={() => setInfo(info === s.id ? null : s.id)}>
                <Tile size={18}>{s.tool.mark}</Tile>
                <span className={s.failed ? "viz-mon-rt bad" : "viz-mon-rt"}>{s.text}</span>
                <span className="viz-mon-rd">{tookOf(s.ms)}</span>
              </button>
              {info === s.id && <StepInfo s={s} total={total} started={p.started} onClose={() => setInfo(null)} />}
            </li>
          ))}
        </ol>
      )}

      {!folded && (asking || (live && (p.onPause || p.onCancel)) || p.progress || p.onLog) && <footer className="viz-mon-foot">
        {asking ? (
          <span className="viz-mon-acts">
            {p.ask!.onDecline && (
              <button type="button" className="viz-mon-ghost" onClick={p.ask!.onDecline}>
                Decline <kbd>Esc</kbd>
              </button>
            )}
            {p.ask!.onAllow && (
              <button type="button" className="viz-mon-allow" onClick={p.ask!.onAllow}>
                {p.ask!.allow ?? "Allow"} <kbd>{ICON.enter}</kbd>
              </button>
            )}
          </span>
        ) : (
          <span className="viz-mon-acts">
            {p.onPause && live && (
              <button type="button" className="viz-mon-soft" onClick={p.onPause}>
                {ICON.pause}
                {p.pauseLabel ?? "Pause"}
              </button>
            )}
            {p.onCancel && live && (
              <button type="button" className="viz-mon-soft" onClick={p.onCancel}>
                {ICON.cancel}
                {p.cancelLabel ?? "Cancel"}
              </button>
            )}
          </span>
        )}
        {p.progress && <span className="viz-mon-n">{`${Math.min(p.progress.done + (p.status === "working" ? 1 : 0), p.progress.total)}/${p.progress.total}`}</span>}
        {p.onLog && (
          <button type="button" className="viz-mon-log" onClick={p.onLog}>
            {p.logLabel ?? "Log"}
            {ICON.out}
          </button>
        )}
      </footer>}
    </section>
  );
}

function StepInfo({ s, total, started, onClose }: { s: MonitorStep; total: number; started?: number; onClose: () => void }) {
  const facts = [
    ...(s.at != null && started != null ? [{ l: "Started", v: `+${clockOf(s.at - started)}` }] : []),
    { l: "Took", v: tookOf(s.ms) },
    { l: "Share", v: `${Math.max(1, Math.round((s.ms / total) * 100))}%` },
    { l: "State", v: s.failed ? "Failed" : "Done" },
  ];
  return (
    <div className="viz-mon-info" role="group" aria-label={s.text}>
      <div className="viz-pop-head">
        <Tile size={26}>{s.tool.mark}</Tile>
        <span className="viz-nm">
          <span className="viz-name">{s.text}</span>
          <span className="viz-model">{s.tool.label}</span>
        </span>
        <button type="button" className="viz-x" aria-label="Close" onClick={onClose}>
          {ICON.x}
        </button>
      </div>
      <dl className="viz-mon-facts">
        {facts.map((f) => (
          <div key={f.l}>
            <dt>{f.l}</dt>
            <dd>{f.v}</dd>
          </div>
        ))}
      </dl>
      {s.note && <p className="viz-mon-note">{s.note}</p>}
      {s.code && <code className="viz-mon-code">{s.code}</code>}
    </div>
  );
}
