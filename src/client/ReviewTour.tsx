import { useEffect, useMemo, useRef, useState } from "react";
import { mergeFindings, reviewOrder, type AgreedFinding } from "../code-review.js";
import type { PullRequest } from "../runner/workspace.js";
import type { PrFile } from "../runner/pr-actions.js";
import { ENGINE_NAMES } from "../types.js";
import { FileIcon } from "./fileIcons.js";
import { hostApi } from "./local.js";
import { openOutside } from "./openOutside.js";
import { isLocal } from "./edition.js";
import { IdeLink } from "./ide/IdeLink.js";
import { reviews, useReviews } from "./prWatch.js";
import type { Identity } from "./storage.js";
import { isTyping } from "./ui.js";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CompassIcon, ExternalLinkIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
// The kit's pieces: the tour only opens inside Code Review, which loads on its own.
import { Button as KitButton } from "@/components/affect/button";
import { Kbd } from "@/components/affect/kbd";

/**
 * A guided tour of a pull request (Arun, 2026-10-25, tier 2: "a PR review page with an AI-guided tour"): its files one at a time,
 * in the order a careful reviewer would read them (code-review.ts reviewOrder: what touches auth, payments or data first, the small
 * mechanical ones last), each with why it is where it is, what the agents' review found in it, and its diff.
 *
 * Rebuilt 2026-11-07 (Arun: "fix the guided tour it is bugged and poorly designed"): it took the `.tour` class of the app's own
 * onboarding tour and so covered the whole window, empty but for a file name; it walked names without their changes; and it
 * said "Read it closely anyway: it infra.". Now it sits where the file list was, with the reading plan beside the file in front
 * of you, the diff itself (from GitHub, through this computer's login), and the findings that point at its lines.
 */

type File = NonNullable<PullRequest["files"]>[number];

/** What makes a file worth a careful look, as the end of a sentence: "it touches auth and changes dependencies". */
const PHRASE: Record<string, string> = {
  Migration: "is a migration",
  "CI config": "changes CI config",
  Dependencies: "changes dependencies",
  Infra: "changes infrastructure",
  "Deletes a test": "deletes a test",
};
const phrase = (risks: string[]) => {
  // "Touches auth" and its kind read as they are; the rest have their words here.
  const ps = risks.map((r) => PHRASE[r] ?? r.charAt(0).toLowerCase() + r.slice(1));
  return ps.length > 1 ? `${ps.slice(0, -1).join(", ")} and ${ps.at(-1)}` : (ps[0] ?? "");
};

/** One line of a diff, numbered as the file is after the change (before it, for a line taken away). */
type Line = { kind: "hunk" | "add" | "del" | "same"; text: string; n?: number };
export function diffLines(patch: string): Line[] {
  const out: Line[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      out.push({ kind: "hunk", text: h[3]!.trim() });
    } else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), n: newN++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), n: oldN++ });
    else if (raw.startsWith("\\")) continue;
    else out.push({ kind: "same", text: raw.slice(1), n: (oldN++, newN++) });
  }
  return out;
}

const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

export function ReviewTour({ identity, pr, files, onClose }: { identity: Identity; pr: PullRequest; files: File[]; onClose: () => void }) {
  useReviews();
  // The diffs, asked of GitHub once the tour opens; until then (or if it can't say) the tour still walks the files.
  const [diffs, setDiffs] = useState<Map<string, PrFile> | null>(null);
  const [diffError, setDiffError] = useState("");
  useEffect(() => {
    let live = true;
    hostApi<{ files: PrFile[] }>(identity, "/api/runner/pr.files", { method: "POST", body: JSON.stringify({ url: pr.url }) }).then(
      (r) => live && setDiffs(new Map(r.files.map((f) => [f.path, f]))),
      (e: Error) => live && (setDiffs(new Map()), setDiffError(e.message || "GitHub didn't answer.")),
    );
    return () => void (live = false);
  }, [identity, pr.url]);

  const steps = useMemo(
    () => reviewOrder(files.map((f) => ({ ...f, status: diffs?.get(f.path)?.status ?? "modified", patch: diffs?.get(f.path)?.patch ?? "" }))),
    [files, diffs],
  );
  const run = reviews.get(pr.url);
  const found = useMemo(() => (run ? mergeFindings(run.results) : []), [run]);
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const step = steps[Math.min(at, steps.length - 1)];
  const path = step?.file.path ?? "";
  useEffect(() => {
    if (path) setSeen((s) => (s.has(path) ? s : new Set(s).add(path)));
  }, [path]);
  const go = (i: number) => setAt(Math.max(0, Math.min(steps.length - 1, i)));

  // ← and → walk it, Escape ends it, while nothing is being typed.
  const keys = useRef({ go, at, onClose });
  keys.current = { go, at, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector(".overlay")) return;
      if (e.key === "ArrowRight") keys.current.go(keys.current.at + 1);
      else if (e.key === "ArrowLeft") keys.current.go(keys.current.at - 1);
      else if (e.key === "Escape") keys.current.onClose();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Opened from the files' heading, it is brought into view: below the card, it opened out of sight on a short window.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const diffBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    diffBox.current?.scrollTo({ top: 0 });
  }, [path]);
  if (!step) return null;
  const f = step.file;
  const here = found.filter((x) => x.path && sameFile(x.path, f.path));
  const lines = diffs?.get(f.path)?.patch ? diffLines(diffs.get(f.path)!.patch!) : null;
  const flagged = new Set(here.map((x) => x.line).filter((n): n is number => !!n));
  const size = f.additions + f.deletions;
  const byWord = (x: AgreedFinding) => (x.by.length > 1 ? `${x.by.map((t) => ENGINE_NAMES[t]).join(" and ")} agree` : ENGINE_NAMES[x.by[0]!]);
  const last = at === steps.length - 1;
  const toLine = (n: number) => diffBox.current?.querySelector<HTMLElement>(`[data-line="${n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  // Why it is where it is in the order, in a sentence.
  const why = step.risks.length
    ? `${at === 0 ? "First, because" : "Read it closely:"} it ${phrase(step.risks)}.`
    : step.mechanical
      ? "Lines moved or imports only: a quick look."
      : size > 300
        ? `A big change: ${size} lines.`
        : size > 60
          ? `A medium change: ${size} lines.`
          : `A small change: ${size} line${size === 1 ? "" : "s"}.`;

  return (
    <section ref={root} className="rt @container" aria-label="Guided tour of the changes">
      {/* Where you are: the tour, how far through (review-center's header: a 6px track and "3 of 8 read"), and the way out. */}
      <header className="rt-head">
        <CompassIcon className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        <span className="rt-title">Guided tour</span>
        <span className="rt-track" aria-hidden>
          <span style={{ width: `${(seen.size / steps.length) * 100}%` }} />
        </span>
        <span className="rt-count">
          <b>{seen.size}</b> of {steps.length} read
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="End the tour" title="End the tour (Esc)" className="rt-x ml-auto" onClick={onClose}>
          <XIcon />
        </Button>
      </header>

      <div className="rt-body">
        {/* The reading plan: every file in the order to read it, what is seen ticked, the one in front of you raised. */}
        <ol className="rt-plan" aria-label="Reading order">
          {steps.map((s, i) => (
            <li key={s.file.path}>
              <button type="button" aria-current={i === at || undefined} onClick={() => go(i)} title={s.file.path} className="rt-step">
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {seen.has(s.file.path) && i !== at ? <CheckIcon className="size-3 text-[var(--text-muted)]" /> : <span className={cn("size-1.5 rounded-full", s.risks.length ? "bg-[var(--dass-needs)]" : "bg-[var(--border-strong)]")} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{base(s.file.path)}</span>
                {found.some((x) => x.path && sameFile(x.path, s.file.path)) && <span className="shrink-0 text-[11px] font-medium text-[var(--red)]" title="The agents found something here">!</span>}
              </button>
            </li>
          ))}
        </ol>

        <div className="rt-detail">
          {/* Why it comes here, then the file as a diff card: its row of 36 (folder quiet, name in ink, the lines changed), its lines. */}
          <p className={cn("rt-why", step.risks.length && "rt-why-risk")}>
            <b>Why</b> {why}
          </p>

          {/* What your agents found in it, as the agent's note: each pointing at its line below. */}
          {here.length > 0 ? (
            <ul className="rt-notes" aria-label="Found in this file">
              {here.slice(0, 5).map((x, i) => (
                <li key={i} className="rt-note">
                  <span className="rt-note-l">
                    <TriangleAlertIcon aria-hidden />
                    {x.severity === "high" ? "High" : x.severity === "medium" ? "Medium" : "Low"} · {byWord(x)}
                  </span>
                  <span className="rt-note-t">
                    <span className="font-medium text-[var(--ink)]">{x.title}</span>
                    {x.detail && <span> {x.detail}</span>}
                  </span>
                  {x.line && lines?.some((l) => l.n === x.line && l.kind !== "del") && (
                    <button type="button" className="rt-note-chip" onClick={() => toLine(x.line!)}>
                      {base(f.path)}:{x.line}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rt-quiet">{run?.results.length ? "Your agents found nothing in this file." : "Run Agent review above the files and what it finds shows here, file by file."}</p>
          )}

          <div className="rt-diff">
            <div className="rt-file">
              <FileIcon path={f.path} size={14} />
              <span className="min-w-0 flex-1 truncate" title={f.path}>
                <span className="text-[var(--text-muted)]">{dir(f.path)}</span>
                {base(f.path)}
              </span>
              {/* In the IDE (Arun, 2026-11-20: "Every file mention opens in the IDE"): the pull request checked out in a copy, this file open there. */}
              {isLocal() && diffs?.get(f.path)?.status !== "removed" && <IdeLink className="link-btn shrink-0 text-[12px]" prFile={{ identity, url: pr.url, title: pr.title, path: f.path }} />}
              <span className="rt-n">
                <span className="text-[var(--green)]">+{f.additions}</span> <span className="text-[var(--red)]">−{f.deletions}</span>
              </span>
            </div>
            <div ref={diffBox} className="rt-lines" aria-label={`Diff of ${f.path}`}>
              {diffs === null ? (
                <p className="rt-quiet rt-center">Reading the changes from GitHub…</p>
              ) : !lines ? (
                <p className="rt-quiet rt-center">
                  {diffError ? `Couldn't read the changes: ${diffError}` : "GitHub doesn't show this file's changes (a binary file, or too big)."}{" "}
                  <button type="button" className="link-btn" onClick={() => openOutside(`${pr.url}/files`)}>
                    See it on GitHub
                  </button>
                </p>
              ) : (
                <table>
                  <tbody>
                    {lines.map((l, i) =>
                      l.kind === "hunk" ? (
                        <tr key={i} className="rt-hunk">
                          <td>⋯</td>
                          <td className="truncate">{l.text}</td>
                        </tr>
                      ) : (
                        <tr key={i} data-line={l.kind !== "del" ? l.n : undefined} data-kind={l.kind}>
                          <td>{l.n}</td>
                          <td>
                            <span className="rt-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                            {/* A line a finding points at: its text marked amber, as the reference marks what the agent is unsure of. */}
                            {l.kind !== "del" && l.n !== undefined && flagged.has(l.n) ? (
                              <>
                                {/^\s*/.exec(l.text)![0]}
                                <mark>{l.text.trimStart()}</mark>
                              </>
                            ) : (
                              l.text
                            )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* On: the action bar, each move with its key. */}
      <footer className="rt-foot">
        <KitButton variant="ghost" icon={<ExternalLinkIcon />} onClick={() => openOutside(`${pr.url}/files`)}>
          On GitHub
        </KitButton>
        <KitButton variant="secondary" className="ml-auto" disabled={at === 0} icon={<ChevronLeftIcon />} onClick={() => go(at - 1)}>
          Back <Kbd keys="left" aria-hidden />
        </KitButton>
        {last ? (
          <KitButton icon={<CheckIcon />} onClick={onClose}>
            Done
          </KitButton>
        ) : (
          <KitButton className="rv-key" iconRight={<ChevronRightIcon />} onClick={() => go(at + 1)}>
            Next <Kbd keys="right" aria-hidden />
          </KitButton>
        )}
      </footer>
    </section>
  );
}
