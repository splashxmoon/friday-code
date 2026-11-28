import { useState } from "react";
import { Icon } from "./icons.js";
import type { RecentSession } from "./storage.js";
import { isTeamSid, useTeamNow } from "./Teammates.js";
import { choosePlace } from "./WorkMode.js";
import "./getting-started.css";
import { OWN_FOLDER } from "./gs-marks.js";

/**
 * Getting started, on the open-source home (Arun, 2026-11-01: "enhance the UX for first users loading up and running the app…
 * so they can retain and be continuously using this product"): the four things that show what Friday is for, each ticked when it
 * has happened, each one press from doing. A first task; one in their own project, not a folder Friday made; their agents working
 * as a team; a teammate who stays. Gone once all four are done, or when hidden.
 */

const HIDDEN = "friday.gs.hidden";
/** Folded to its head and bar, as the setup guide folds away (kept on this computer). */
const FOLDED = "friday.gs.folded";

const read = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const mark = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    // A tick: losing it shows the step again, nothing more.
  }
};

const focusBox = () => document.querySelector<HTMLTextAreaElement>(".composer-card textarea")?.focus();

export function GettingStarted({ recents, onPickFolder }: { recents: RecentSession[]; /** Opens the box's folder picker. */ onPickFolder: () => void }) {
  const t = useTeamNow();
  const [hidden, setHidden] = useState(() => read(HIDDEN));
  const [folded, setFolded] = useState(() => read(FOLDED));
  const fold = (on: boolean) => {
    setFolded(on);
    try {
      localStorage.setItem(FOLDED, on ? "1" : "0");
    } catch {
      // Not kept: it opens again next time, nothing more.
    }
  };
  // The step that shows what it is about: the next one, until another is pressed (the setup guide opens one group at a time).
  const [opened, setOpened] = useState<string | null>(null);
  const own = recents.filter((r) => !isTeamSid(r.sid));
  const steps = [
    { id: "task", title: "Give an agent its first task", body: "Describe a change in the box above. It works in a folder of its own until you pick one.", done: own.length > 0, act: "Write it", run: focusBox },
    { id: "folder", title: "Point it at your own project", body: "Pick a folder or repo, and the agent works on your real code, on a branch of its own.", done: read(OWN_FOLDER), act: "Pick a folder", run: onPickFolder },
    // The Crew, which opens on its three-click setup (CrewSetup.tsx) while nobody is on it, not the full New agent form (the "Why
    // Crew" plan, 2026-11-13).
    { id: "mate", title: "Add an agent who stays", body: "Say what you want help with and Friday suggests the crew. They keep their memory and work through their queue while you're away.", done: !!t?.teammates.length, act: "Add", run: () => choosePlace("team") },
  ];
  const done = steps.filter((s) => s.done).length;
  if (hidden || done === steps.length) return null;
  const next = steps.find((s) => !s.done)!;
  const open = steps.find((s) => s.id === opened && !s.done) ?? next;
  // As the affectUI setup guide (SPEC setup-guide): a title with Hide, a 4px bar with "1/3", then the steps, the open one on a
  // tint with what it's about and its button; a done one ticked and struck through. Every step keeps its button, one press away.
  return (
    <section className="gs-card" aria-label="Get started" data-folded={folded || undefined}>
      <div className="gs-head">
        <h2>Get started</h2>
        <button type="button" className="gs-hide" onClick={() => (mark(HIDDEN), setHidden(true))}>
          Hide
        </button>
        {/* Fold to the head and its bar, and back (the setup guide's minimise; the lead's call for Arun, 2026-11-27). */}
        <button type="button" className="gs-fold" aria-expanded={!folded} aria-label={folded ? "Show the steps" : "Fold the steps away"} title={folded ? "Show the steps" : "Fold the steps away"} onClick={() => fold(!folded)}>
          <Icon name={folded ? "expand" : "shrink"} size={16} />
        </button>
      </div>
      <div className="gs-progress">
        <span className="gs-bar" role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
          <i style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <span className="gs-count">
          {done}/{steps.length}
        </span>
      </div>
      {!folded && (
      <ol className="gs-list">
        {steps.map((s) => (
          <li key={s.id} className="gs-step" data-done={s.done ? "true" : undefined} data-next={s === next ? "true" : undefined} data-open={s === open ? "true" : undefined}>
            <span className="gs-row">
              <span className="gs-tick" aria-hidden="true">
                {s.done && <Icon name="check" size={10} />}
              </span>
              {s.done ? (
                <span className="gs-title">{s.title}</span>
              ) : (
                <button type="button" className="gs-title" aria-expanded={s === open} onClick={() => setOpened(s.id)}>
                  {s.title}
                </button>
              )}
              {!s.done && (
                <button type="button" className={s === open ? "gs-go primary" : "gs-go"} onClick={s.run}>
                  {s.act}
                </button>
              )}
            </span>
            {s === open && <p className="gs-body">{s.body}</p>}
          </li>
        ))}
      </ol>
      )}
    </section>
  );
}
