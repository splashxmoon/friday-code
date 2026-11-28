import type { IconName } from "./icons.js";

/**
 * What the What's new sheet says after an update (WhatsNew.tsx): the release's few changes worth stopping for, written with its
 * notes at each open-source release (the changelog's top entry says everything; this says four things). The sheet shows once for
 * each `version` here, so a release that leaves this as it was shows nothing new.
 */
export interface WhatsNewNotes {
  /** The release these are for, as tagged (v0.2.10 → "0.2.10"). */
  version: string;
  /** The release's own headline, when it has one worth leading with; else "What's new in Friday". */
  title?: string;
  /** One sentence under the title: what the release adds up to. */
  summary: string;
  /** Up to four, in a two-by-two grid. */
  items: { icon: IconName; title: string; line: string }[];
}

export const WHATS_NEW: WhatsNewNotes = {
  version: "0.4.5",
  summary: "Captains that run a crew until the job is done, a new look across the app, automations that start on GitHub, and four more coding tools.",
  items: [
    { icon: "crown", title: "Captains with a crew", line: "Tell a project's Captain what you want: it plans the steps, runs a crew of agents, checks each one and keeps going until done." },
    { icon: "star", title: "A new look", line: "Every page redrawn on one set of parts: calmer cards, clearer states, the same menus and buttons everywhere." },
    { icon: "zap", title: "Starts itself on GitHub", line: "Automations can run when an issue is opened, someone opens a pull request, or a check fails on main." },
    { icon: "plug", title: "Four more coding tools", line: "Aider, Crush, Auggie and Goose, added by contributors: 22 tools side by side in one app." },
  ],
};

/** The open-source repository, to star (2026-11-25: "I want more users and stars and contributors"). */
export const REPO_URL = "https://github.com/splashxmoon/friday-code";

/** The release's own page, for everything else it changed. */
export const notesUrl = (version: string) => `https://github.com/splashxmoon/friday-code/releases/tag/v${version}`;

/** A version as its release is tagged: 0.2.10-mine.202611040538 is 0.2.10. */
export const releaseOf = (version: string) => version.trim().replace(/^v/, "").replace(/[-+].*$/, "");

/**
 * The sheet is due only on the first start after an update (Arun, 2026-11-04: "only appears after ugrading to new version the
 * first time... like not randomly"): this Friday is a different version from the one that ran here last, these notes are this
 * version's, and they haven't been shown. Before Friday kept the last version (`last` null), someone it already knew (past the
 * welcome) counts as updated; someone new doesn't, and never sees notes for the version they installed.
 */
export function whatsNewDue(p: { notes: string; running: string; last: string | null; shown: string | null; knew: boolean }): boolean {
  const now = releaseOf(p.running);
  if (!now || p.notes !== now || p.shown === p.notes) return false;
  return p.last ? releaseOf(p.last) !== now : p.knew;
}
