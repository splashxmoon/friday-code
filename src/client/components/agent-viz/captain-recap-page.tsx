// The Captain's Recap as a page of its own (Arun, 2026-11-28: "make the recap modal into an page actually with proof clips when
// dealing and working with UI work"). The plan it's about at the top, with what it came to; the proof clip of the pages it changed
// (recorded when the plan finishes and proof clips are on, or on Record here); the Captain's summary; then what needs you, what
// failed and what's done, as the dialog showed them.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionEvent } from "../../../types.js";
import { api } from "../../api.js";
import { Icon } from "../../icons.js";
import { md } from "../../markdown.js";
import type { ManagersApi, ManagerView } from "../../Managers.js";
import { ProofClipCard, ProofStatusCard } from "../../ProofClipCard.js";
import type { Identity } from "../../storage.js";
import { CaptainRecap } from "./captain-places.js";
import "./captain-recap-page.css";

type Task = { id: string; text: string; status: string; started?: number; ended?: number; files?: string[]; added?: number; removed?: number; applied?: boolean };
type Plan = {
  id: string;
  at: number;
  captainUsd?: number;
  status: string;
  goal?: string;
  tasks: (Task & { agent?: string; copy?: boolean; skipped?: boolean; bringFailed?: boolean; checked?: string })[];
  report?: string;
  final?: { status: string; why?: string };
  round?: number;
  verdict?: { met: boolean; why?: string; criteria?: { text: string; ok: boolean; proof?: string; friday?: { cmd: string; ok: boolean; out?: string } }[] };
  assumed?: string[];
  shipped?: { how: string; branch?: string; sha?: string; pushed?: boolean; prUrl?: string; error?: string };
};

const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const STATUS: Record<string, [string, string]> = { running: ["Working", "run"], done: ["Done", "done"], cancelled: ["Stopped", "stop"], draft: ["Waiting for your Start", "wait"] };

export default function CaptainRecapPage({ identity, m, a, open, onBack }: { identity: Identity; m: ManagerView; a: ManagersApi; open: (sid: string) => void; onBack: () => void }) {
  const plans = useMemo(() => [...(((m as unknown as { plans?: Plan[] }).plans ?? []))].filter((p) => p.status !== "draft").sort((x, y) => y.at - x.at), [m]);
  const plan = plans.find((p) => p.status === "running") ?? plans[0];
  const title = plan ? (m.goals?.find((g) => g.id === plan.goal)?.title ?? "The plan") : "";
  const [clips, setClips] = useState<{ sid: string | null; clips: SessionEvent[] } | null>(null);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const read = useCallback(() => api<{ sid: string | null; clips: SessionEvent[] }>(identity, `/api/managers/${m.id}/clips`).then(setClips).catch(() => {}), [identity, m.id]);
  // The clips this plan made, and how the one being made is going: read on opening, and every few seconds while one is being made.
  const mine = (clips?.clips ?? []).filter((e) => plan && e.ts >= plan.at);
  const made = mine.filter((e) => e.body.type === "proof.clip" && (e.body as { by?: string }).by !== "check").reverse();
  const status = mine.filter((e) => e.body.type === "proof.status").at(-1);
  const making = !!status && !mine.some((e) => e.seq > status.seq) && (status.body as { stage?: string }).stage !== "failed" && Date.now() - status.ts < 10 * 60_000;
  useEffect(() => {
    void read();
    const t = setInterval(() => void read(), making || asking ? 3000 : 15000);
    return () => clearInterval(t);
  }, [read, making, asking]);
  const record = async () => {
    if (!plan) return;
    setAsking(true);
    setErr("");
    const r = await api<{ error?: string }>(identity, `/api/managers/${m.id}/plans/${plan.id}/proof`, { method: "POST" }).catch((e: Error) => ({ error: e.message }));
    if (r?.error) setErr(r.error);
    await read();
    setTimeout(() => setAsking(false), 4000);
  };
  // The whole record of the goal (every round, step, agent, tool and why, the verdict and the log): copied, or saved to Downloads.
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState("");
  const exportRecord = async (how: "copy" | "save") => {
    if (!plan) return;
    const r = await api<{ text?: string; file?: string; error?: string }>(identity, `/api/managers/${m.id}/plans/${plan.id}/record`, how === "save" ? { method: "POST" } : {}).catch((e: Error) => ({ error: e.message }) as { text?: string; file?: string; error?: string });
    if (r.error || !r.text) return setSaved(r.error ?? "Couldn't make the record");
    if (how === "save") return setSaved(r.file ?? "");
    await navigator.clipboard.writeText(r.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500))).catch(() => setSaved("Couldn't copy"));
  };
  // The goal across its rounds: every plan made for it, oldest first, so the report covers the whole night, not only its last round.
  const goal = plan ? m.goals?.find((g) => g.id === plan.goal) : undefined;
  const rounds = plan ? plans.filter((p) => p.goal === plan.goal).reverse() : [];
  const tasks = rounds.flatMap((p) => p.tasks);
  const crew = (m as unknown as { agents?: { id: string; usd?: number }[] }).agents ?? [];
  const usd = [...new Set(tasks.map((t) => t.agent).filter(Boolean))].reduce((n, id) => n + (crew.find((x) => x.id === id)?.usd ?? 0), rounds.reduce((n, p) => n + (p.captainUsd ?? 0), 0));
  const copies = tasks.filter((t) => t.status === "done" && t.copy && !t.skipped);
  const inFolder = copies.filter((t) => t.applied).length;
  const v = plan?.verdict;
  const criteria = v?.criteria?.length ? v.criteria : (goal as { criteria?: string[] } | undefined)?.criteria?.map((text) => ({ text, ok: false, proof: "Not judged yet" })) ?? [];
  const assumed = rounds.flatMap((p) => p.assumed ?? []);
  // What the crew wrote down for each other (managers.ts withNotebook).
  const notebook = (goal as { notebook?: { at: number; by: string; text: string }[] } | undefined)?.notebook ?? [];
  const shipped = plan?.shipped;
  const [kept, setKept] = useState<Record<string, "keep" | "change" | "sent">>({});
  const [change, setChange] = useState<Record<string, string>>({});
  const started = Math.min(...tasks.map((t) => t.started ?? Infinity));
  const ended = Math.max(...tasks.map((t) => t.ended ?? 0));
  const files = new Set(tasks.flatMap((t) => t.files ?? []));
  const added = tasks.reduce((n, t) => n + (t.added ?? 0), 0);
  const removed = tasks.reduce((n, t) => n + (t.removed ?? 0), 0);
  const done = tasks.filter((t) => t.status === "done").length;
  const [word, tone] = plan
    ? plan.status === "running"
      ? plan.final?.status === "checking"
        ? ["Checking the whole", "run"]
        : tasks.some((t) => t.status === "failed")
          ? ["Held on a failed step", "stop"]
          : ["Working", "run"]
      : plan.status === "done" && v
        ? v.met
          ? ["Done", "done"]
          : ["Done with notes", "wait"]
        : (STATUS[plan.status] ?? [plan.status, ""])
    : ["", ""];
  const sid = clips?.sid ?? m.sid ?? "";
  return (
    <div className="crp" data-testid="captain-recap-page">
      <header className="crp-head">
        <button type="button" className="cch-btn" onClick={onBack} title="Back to the crew (Esc)">
          <Icon name="arrowLeft" size={14} />
          Crew
        </button>
        <span className="crp-crumb">Recap</span>
        {plan && (
          <span className="crp-acts">
            {saved && <span className="crp-saved" title={saved}>{saved.startsWith("/") ? "Saved to Downloads" : saved}</span>}
            <button type="button" className="cch-btn" onClick={() => void exportRecord("copy")} title="Copy the whole record of this goal, every step and why, as Markdown">
              <Icon name={copied ? "check" : "copy"} size={13} />
              {copied ? "Copied" : "Copy record"}
            </button>
            <button type="button" className="cch-btn" onClick={() => void exportRecord("save")} title="Save the whole record of this goal to your Downloads folder as Markdown">
              <Icon name="download" size={13} />
              Save
            </button>
          </span>
        )}
      </header>
      <div className="crp-body">
        {plan ? (
          <>
            <section className="crp-top">
              <div className="crp-title">
                <h1>{title}</h1>
                {word && <span className={`crp-chip ${tone}`}>{word}</span>}
                {rounds.length > 1 && <span className="crp-round">Round {plan.round ?? rounds.length}</span>}
              </div>
              {v?.why && <p className="crp-why">{v.why}</p>}
              <dl className="crp-facts">
                {usd > 0 && (
                  <div>
                    <dt>Cost</dt>
                    <dd>{usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`}</dd>
                  </div>
                )}
                {copies.length > 0 && (
                  <div>
                    <dt>In your folder</dt>
                    <dd className={inFolder < copies.length ? "warn" : ""}>
                      {inFolder} of {copies.length}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Steps</dt>
                  <dd>
                    {done} of {tasks.length}
                  </dd>
                </div>
                {Number.isFinite(started) && (
                  <div>
                    <dt>Took</dt>
                    <dd>{span((ended > started ? ended : Date.now()) - started)}</dd>
                  </div>
                )}
                {(added > 0 || removed > 0) && (
                  <div>
                    <dt>Lines</dt>
                    <dd>
                      <b className="add">+{added.toLocaleString()}</b> <b className="del">−{removed.toLocaleString()}</b>
                    </dd>
                  </div>
                )}
                {files.size > 0 && (
                  <div>
                    <dt>Files</dt>
                    <dd>{files.size}</dd>
                  </div>
                )}
                {plan.final?.status && plan.final.status !== "checking" && (
                  <div>
                    <dt>Check</dt>
                    <dd className={plan.final.status === "passed" ? "ok" : plan.final.status === "failed" ? "bad" : ""}>{plan.final.status === "passed" ? "Passes" : plan.final.status === "failed" ? "Fails" : "None run"}</dd>
                  </div>
                )}
              </dl>
            </section>

            {shipped && (
              <section className="crp-ship" aria-label="Where it went">
                <Icon name={shipped.prUrl ? "gitPullRequest" : "gitBranch"} size={14} />
                <span>
                  {shipped.prUrl ? (
                    <>
                      Pull request open:{" "}
                      <a href={shipped.prUrl} target="_blank" rel="noreferrer">
                        {shipped.prUrl.replace(/^https:\/\/github\.com\//, "")}
                      </a>
                    </>
                  ) : shipped.pushed ? (
                    `Pushed to ${shipped.branch}`
                  ) : shipped.sha ? (
                    `Committed to ${shipped.branch} on this Mac (${shipped.sha.slice(0, 7)})`
                  ) : (
                    "In your folder, not committed: look it over, then commit it yourself."
                  )}
                  {shipped.error && <em className="crp-ship-err"> {shipped.error}</em>}
                </span>
                <button type="button" className="cch-btn" onClick={() => dispatchEvent(new CustomEvent("friday:captain-panel", { detail: "changes" }))} title="Back to the crew with Changes open">
                  See changes
                </button>
              </section>
            )}

            {criteria.length > 0 && (
              <section className="crp-sec" aria-label="Done when">
                <div className="crp-sec-head">
                  <h2>Done when</h2>
                  <span className="crp-count">
                    {criteria.filter((c) => c.ok).length} of {criteria.length} proved
                  </span>
                </div>
                <ul className="crp-crit">
                  {criteria.map((c, i) => (
                    <li key={i} className={c.ok ? "ok" : ""}>
                      <span className="crp-tick" aria-label={c.ok ? "Proved" : "Not proved"}>
                        {c.ok ? <Icon name="check" size={11} strokeWidth={2.2} /> : null}
                      </span>
                      <span className="crp-crit-t">
                        {c.text}
                        {/* With Friday's own run beside it, only the Captain's words (the badge says what Friday ran). */}
                        {((p) => p && <em>{p}</em>)("friday" in c && c.friday ? (c.proof ?? "").replace(/^Friday ran `[^`]*` and it (?:passes|failed)(?:\. | \(the Captain said: )?/, "").replace(/\)$/, "") : c.proof)}
                        {/* Friday's own run of its check (managers-run judged), its output's end on hover. */}
                        {"friday" in c && c.friday && (
                          <span className={`crp-ran ${c.friday.ok ? "ok" : "bad"}`} title={c.friday.out ?? ""}>
                            <Icon name="terminal" size={11} />
                            <code>{c.friday.cmd}</code>
                            {c.friday.ok ? "passes" : "fails"}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="crp-sec" aria-label="Proof">
              <div className="crp-sec-head">
                <h2>Proof</h2>
                {(made.length > 0 || status) && !making && (
                  <button type="button" className="cch-btn" onClick={() => void record()} disabled={asking} title="Record the pages this plan changed again">
                    <Icon name="play" size={12} />
                    Record again
                  </button>
                )}
              </div>
              {making && status && <ProofStatusCard ev={status} events={mine} sid={sid} invite="" onRetry={() => void record()} />}
              {!making && status && (status.body as { stage?: string }).stage === "failed" && !made.some((c) => c.seq > status.seq) && <ProofStatusCard ev={status} events={mine} sid={sid} invite="" onRetry={() => void record()} />}
              {made.length > 0 ? (
                <div className="crp-clips">
                  {made.slice(0, 3).map((c) => (
                    <ProofClipCard key={c.seq} ev={c} sid={sid} invite="" />
                  ))}
                </div>
              ) : (
                !making &&
                !status && (
                  <div className="crp-empty">
                    <span className="crp-empty-ic" aria-hidden>
                      <Icon name="play" size={16} />
                    </span>
                    <div>
                      <p className="crp-empty-t">No proof clip yet</p>
                      <p className="crp-empty-s">When the crew changes a page, Friday records it from your dev server once the plan is done, with proof clips on in Settings. Or record it now.</p>
                    </div>
                    <button type="button" className="cch-btn primary" onClick={() => void record()} disabled={asking || plan.status === "running"} title={plan.status === "running" ? "Once the plan is done" : "Record the pages this plan changed"}>
                      <Icon name="play" size={12} />
                      {asking ? "Starting…" : "Record a proof clip"}
                    </button>
                  </div>
                )
              )}
              {err && (
                <p className="crp-err" role="alert">
                  {err}
                </p>
              )}
            </section>

            {notebook.length > 0 && (
              <section className="crp-sec" aria-label="Crew notebook">
                <div className="crp-sec-head">
                  <h2>Crew notebook</h2>
                  <span className="crp-count">{notebook.length}</span>
                </div>
                <ul className="crp-notes">
                  {notebook.slice(-12).map((n, i) => (
                    <li key={i}>
                      <span className="crp-notes-by">{n.by}</span>
                      <p>{n.text}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {assumed.length > 0 && (
              <section className="crp-sec" aria-label="Assumptions">
                <div className="crp-sec-head">
                  <h2>Decided while you were away</h2>
                </div>
                <ul className="crp-assume">
                  {assumed.map((x, i) => (
                    <li key={i}>
                      <p>{x}</p>
                      {kept[x] === "keep" ? (
                        <span className="crp-kept">Kept</span>
                      ) : kept[x] === "sent" ? (
                        <span className="crp-kept">Sent to the Captain</span>
                      ) : kept[x] === "change" ? (
                        <form
                          className="crp-change"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const t = (change[x] ?? "").trim();
                            if (!t) return;
                            void a.say(m.id, `Change what you decided ("${x}"): ${t}`).then(() => setKept((k) => ({ ...k, [x]: "sent" })));
                          }}
                        >
                          <input autoFocus value={change[x] ?? ""} onChange={(e) => setChange((c) => ({ ...c, [x]: e.currentTarget.value }))} placeholder="What should it be instead?" aria-label="What should it be instead?" />
                          <button type="submit" className="cch-btn primary" disabled={!(change[x] ?? "").trim()}>
                            Send
                          </button>
                        </form>
                      ) : (
                        <span className="crp-assume-acts">
                          <button type="button" className="cch-btn" onClick={() => setKept((k) => ({ ...k, [x]: "keep" }))}>
                            Keep
                          </button>
                          <button type="button" className="cch-btn" onClick={() => setKept((k) => ({ ...k, [x]: "change" }))}>
                            Change
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {plan.report && (
              <section className="crp-sec" aria-label="Summary">
                <div className="crp-sec-head">
                  <h2>Summary</h2>
                </div>
                <div className="crp-report md" dangerouslySetInnerHTML={{ __html: md(plan.report) }} />
              </section>
            )}
          </>
        ) : (
          <div className="crp-empty big">
            {/* No plan, which is all it can say: today's threads still show under What happened below (2026-11-28: "Nothing to
                recap yet" sat above a Done and a Failed). */}
            <p className="crp-empty-t">No plan yet</p>
            <p className="crp-empty-s">Give the Captain a goal in the chat. Once its crew is on it, what they did and the proof show up here.</p>
          </div>
        )}
        <section className="crp-sec crp-what" aria-label="What happened">
          <CaptainRecap m={m} api={a} open={open} close={onBack} />
        </section>
      </div>
    </div>
  );
}
