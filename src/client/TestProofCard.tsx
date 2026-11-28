/**
 * Test proof in the chat (types.ts proof.tests, test-proof.ts; Arun, 2026-11-22: "how do we show proofs for tests ran and stuff?", then
 * "make this slimmer and better designed as well"): for a change that draws nothing, the tests that ran on it, in one line: passed or
 * failing, the test command (only its test part: "cd app && npm test" reads "npm test"), its counts and how long it took, the output on
 * request. Several commands are a line each under it; the tests that failed are named under theirs. Who ran it is on the mark; Friday
 * checking a reply that only said so says it in the line. Can be put away, as a clip can.
 *
 * It is the one card for a check (the redesign of 2026-11-27): a pass stays this one quiet line; a failure opens to the failing
 * tests, what the first expected and got when its runner printed that, and Fix it on the card, where the reply used to say it again
 * above its answer with a "Check failed" tag and a Fix it pill.
 */
import { useState } from "react";
import type { SessionEvent } from "../types.js";
import { countsLine, expectedGot, testPart } from "../test-proof.js";
import { Icon } from "./icons.js";
import "./proof-clip-card.css";

const KEY = (sid: string) => `friday.testProofHidden.${sid}`;
const hiddenOf = (sid: string): Set<number> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY(sid)) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
};
const keep = (sid: string, seq: number, on: boolean) => {
  try {
    const s = hiddenOf(sid);
    if (on) s.add(seq);
    else s.delete(seq);
    localStorage.setItem(KEY(sid), JSON.stringify([...s].slice(-50)));
  } catch {}
};

type Run = Extract<SessionEvent["body"], { type: "proof.tests" }>["runs"][number];

export function TestProofCard({ ev, sid, by, onFix }: { ev: SessionEvent; sid: string; /** Whose agent ran them, for the mark's title. */ by?: string; /** Ask the same agent to fix the first failure: a check of the lane's latest run, for someone who can. */ onFix?: (() => void) | undefined }) {
  const b = ev.body;
  const [hidden, setHidden] = useState(() => hiddenOf(sid).has(ev.seq));
  const [open, setOpen] = useState(false);
  if (b.type !== "proof.tests" || !b.runs?.length) return null;
  const runs = b.runs;
  const ok = runs.every((r) => r.ok);
  const failed = runs.reduce((n, r) => n + (r.failed ?? (r.ok ? 0 : r.failing?.length || 1)), 0);
  const title = ok ? "Tests passed" : failed === 1 ? "1 test failing" : `${failed} tests failing`;
  const who = b.by === "friday" ? "Friday ran them: the reply said the tests pass, and nothing in its turn ran them" : `Run by ${by || "the agent"} in this turn`;
  const hide = (on: boolean) => (setHidden(on), keep(sid, ev.seq, on));
  const one = runs.length === 1 ? runs[0]! : null;
  const tails = runs.filter((r) => r.tail);
  const counts = (r: Run) => countsLine(r) || (r.ok ? "passed" : "failed");
  if (hidden)
    return (
      <div className="pcc-folded">
        <Icon name={ok ? "check" : "x"} size={11} />
        <span>
          {title} · {runs.map((r) => testPart(r.command)).join(", ")}
        </span>
        <button type="button" className="link-btn" onClick={() => hide(false)}>
          Show
        </button>
      </div>
    );
  return (
    <section className={`tpc${ok ? " is-ok" : " is-bad"}`} aria-label={`Test proof: ${title}`}>
      <div className="tpc-head">
        <span className="tpc-badge" title={who} aria-label={who}>
          <Icon name={ok ? "check" : "x"} size={10} />
        </span>
        <span className="tpc-title">{title}</span>
        {one ? (
          <>
            <code className="tpc-cmd" title={one.command}>
              {testPart(one.command)}
            </code>
            {/* A failure's title already counts it ("1 test failing"). */}
            {ok && <span className="tpc-counts">{counts(one)}</span>}
          </>
        ) : (
          <span className="tpc-counts">{runs.length} commands</span>
        )}
        {b.by === "friday" && (
          <span className="tpc-tag" title={who}>
            by Friday
          </span>
        )}
        {/* When it passed, at the end of its quiet line (the polish mock's pass line). */}
        {ok && <span className="tpc-time">{new Date(ev.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
        <span className="tpc-sp" />
        {tails.length > 0 && (
          <button type="button" className="tpc-tog" aria-label="Output" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="tpc-long">Output</span>
            <Icon name="chevronDown" size={12} className={open ? "tpc-chev open" : "tpc-chev"} />
          </button>
        )}
        <button type="button" className="pcc-x tpc-x" aria-label="Hide this test proof" title="Hide" onClick={() => hide(true)}>
          <Icon name="x" size={12} />
        </button>
        {!ok && onFix && (
          <button type="button" className="btn small primary tpc-fix" title="Ask the agent to fix the first failure and run the check again" onClick={onFix}>
            <Icon name="wrench" size={13} />
            Fix it
          </button>
        )}
      </div>
      {(!one || !!one.failing?.length) && (
        <ul className="tpc-runs">
          {runs.map((r, i) => (
            <li key={i} className={r.ok ? "ok" : "bad"}>
              {!one && (
                <div className="tpc-run">
                  <span className="tpc-dot" aria-hidden="true" />
                  <code className="tpc-cmd" title={r.command}>
                    {testPart(r.command)}
                  </code>
                  <span className="tpc-counts">{counts(r)}</span>
                </div>
              )}
              {!!r.failing?.length && (
                <ul className="tpc-failing">
                  {r.failing.map((f, j) => {
                    // What the first failure expected and got, in mono under its name, where the runner printed it.
                    const eg = j === 0 ? expectedGot(r.tail) : null;
                    return (
                      <li key={f}>
                        <span className="tpc-fail-mark" aria-hidden="true" />
                        <span className="tpc-fail-name" title={f}>
                          {f}
                        </span>
                        {eg && <span className="tpc-why">expected {eg.expected}, got {eg.got}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && <pre className="tpc-out">{tails.map((r) => (tails.length > 1 ? `$ ${testPart(r.command)}\n${r.tail}` : r.tail)).join("\n\n")}</pre>}
    </section>
  );
}
