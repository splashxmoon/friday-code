/**
 * A project's Captain as a page of its own (Arun, 2026-11-27: "make it a page that you can work and view stuff instead of a
 * modal"; docs/plans/captain-v2.md). The conversation on the left, where you talk to it; on the right what it is running: its
 * agents as a tree, the changes they made over time, what happened while you were away, and where the tokens went. Opened from a
 * Captain anywhere in the sidebar (friday:captain), its settings still a sheet of their own. Loaded when first opened.
 */
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaptainChat, type ChatPanel } from "./CaptainChat.js";
import { CaptainSettings } from "./ManagerWindow.js";
import { useManagers } from "./Managers.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { onBand } from "./ui.js";
import "./captain-page.css";

const places = () => import("./components/agent-viz/captain-places.js");
const CaptainTree = lazy(() => places().then((x) => ({ default: x.CaptainTree })));
// The Recap as a page in the crew's pane, with its proof clips (Arun, 2026-11-28: "make the recap modal into an page").
const CaptainRecapPage = lazy(() => import("./components/agent-viz/captain-recap-page.js"));
const CrewPanel = lazy(() => places().then((x) => ({ default: x.CrewPanel })));

/** Where the chat panel was left, per computer (Arun, 2026-11-27: "a side panel that can be collapsed and closed"). */
const PANEL_KEY = "friday.captain.chat";
const panelAt = (): ChatPanel => {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    // No fold any more (Arun, 2026-11-27: "get rid of this button"): a chat left folded opens.
    return v === "closed" ? v : "open";
  } catch {
    return "open";
  }
};

export default function CaptainPage({
  identity,
  id,
  onBack,
}: {
  identity: Identity;
  id: string;
  onBack: () => void;
}) {
  const api = useManagers(identity);
  // A thread opened from here, by the app's own way in (App.tsx friday:open-session), not a lookup of App's own: its first load's budget.
  const onOpen = (sid: string) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } }));
  const [panel, setPanel0] = useState<ChatPanel>(panelAt);
  const setPanel = (p: ChatPanel) => {
    setPanel0(p);
    try {
      localStorage.setItem(PANEL_KEY, p);
    } catch {
      /* kept for this visit only */
    }
  };
  // "Answer in chat" from the crew tree with the chat closed opens it (captain-places.tsx friday:captain-chat).
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === "open" && setPanel("open");
    addEventListener("friday:captain-chat", on);
    return () => removeEventListener("friday:captain-chat", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [bottom, setBottom] = useState(false);
  const [view, setView] = useState<"changes" | "cost">("changes");
  const [recap, setRecap] = useState(false);
  // The agent picked in the crew tree (or the Captain), which the bottom panel shows: kept across the list's reads, Esc or a click on
  // the tree's empty space clears it (Arun, 2026-11-27: the panel's "logic and everything is completely off").
  const [sel, setSel] = useState<string | null>(null);
  // "Review changes" and "Look first" in the chat open the whole crew's changes (CaptainChat.tsx friday:captain-panel): off the
  // Recap, on Changes rather than Cost, with no agent picked.
  useEffect(() => {
    const on = () => (setRecap(false), setView("changes"), setSel(null), setBottom(true));
    addEventListener("friday:captain-panel", on);
    return () => removeEventListener("friday:captain-panel", on);
  }, []);
  // Not on the Recap page: its own Esc goes back to the crew, and shouldn't drop the pick as well.
  useEffect(() => {
    if (!sel || recap) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      if ((e.target as Element | null)?.closest?.(".crew-panel, input, textarea, [contenteditable]")) return;
      setSel(null);
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [sel, recap]);
  const [sheet, setSheet] = useState(false);
  // Esc on the Recap page goes back to the crew, unless something on it (a clip enlarged, a field) takes it first.
  useEffect(() => {
    if (!recap) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable]")) return;
      setRecap(false);
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [recap]);
  const m = api.managers.find((x) => x.id === id);
  // In the desktop app its header and tabs are the window's own band, laid out as a session's header is, so the conversation
  // starts under the same line as the sidebar (Arun, 2026-11-27: "this has to be lined up"); in a browser, a bar of its own.
  const [band, setBand] = useState<{ left: HTMLElement; right: HTMLElement } | null>(null);
  useLayoutEffect(
    () =>
      onBand(() => {
        const left = document.getElementById("band-left");
        const right = document.getElementById("band-slot");
        if (!left || !right) return;
        setBand({ left, right });
        document.documentElement.dataset.band = "session";
        return () => {
          setBand(null);
          if (document.documentElement.dataset.band === "session") delete document.documentElement.dataset.band;
        };
      }),
    [],
  );
  // The band's left half sits on the traffic lights' row with the sidebar open, and on a row of its own below it with the sidebar
  // folded (WindowNav.tsx): the page starts under it then, or its header sat over the first message (Arun, 2026-11-27: "fix this").
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = page.current;
    if (!band || !el) return;
    // Its own top padding doesn't move its box, so it is measured as it stands and set only when it changes: resetting it first
    // made the page jump on every look and the border flicker (Arun, 2026-11-27: "this border thing is flickering").
    const fit = () => {
      const b = band.left.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      const over = `${b.height && b.bottom > p.top + 1 ? Math.ceil(b.bottom - p.top) : 0}px`;
      if (el.style.getPropertyValue("--cpt-top") !== over) el.style.setProperty("--cpt-top", over);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.documentElement);
    ro.observe(band.left);
    // Another screen leaving can clear the band's mode after this one set it (Arun, 2026-11-27: "when i click out of it and go
    // back the header is messed up"): while this page is up, it is put back.
    const mo = new MutationObserver(() => {
      if (document.documentElement.dataset.band !== "session") document.documentElement.dataset.band = "session";
      fit();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-band"] });
    mo.observe(band.left, { attributes: true, attributeFilter: ["style", "class"] });
    return () => (ro.disconnect(), mo.disconnect());
  }, [band, !!m]);
  if (!m)
    return (
      <div className="cpt-page cpt-empty" role="status">
        {api.managers.length || api.loaded ? "This Captain is gone. It may have been removed." : "Loading the Captain…"}
      </div>
    );
  // On the right of the window's band: the bottom panel, the chat panel and the Captain's settings, in that order (Arun, 2026-11-27).
  const tabs = (
    <div className="cpt-tabs" role="toolbar" aria-label="The Captain's page">
      <button type="button" className={`panel-tab icon ${panel === "open" ? "on" : ""}`} onClick={() => setPanel(panel === "open" ? "closed" : "open")} aria-pressed={panel === "open"} aria-label={panel === "open" ? "Close the chat" : "Open the chat"} title="Chat">
        <Icon name="sidePanel" size={18} />
      </button>
      <button type="button" className={`panel-tab icon ${bottom ? "on" : ""}`} onClick={() => setBottom(!bottom)} aria-pressed={bottom} aria-label={bottom ? "Hide changes and cost" : "Show changes and cost"} title="Changes and cost">
        <PanelMark />
      </button>
      <button type="button" className="panel-tab icon" onClick={() => setSheet(true)} aria-haspopup="dialog" aria-label="Captain settings" title="Settings">
        <Icon name="settings" size={17} />
      </button>
    </div>
  );
  return (
    <div ref={page} className={`cpt-page${band ? " in-band" : ""}`} data-testid="captain-page">
      {band && createPortal(tabs, band.right)}
      <CaptainChat m={m} api={api} headIn={band?.left ?? null} onSettings={() => setSheet(true)} open={onOpen} onBack={onBack} panel={panel} setPanel={setPanel}>
        <main className="cpt-work">
          {!band && tabs}
          <section className="cpt-pane" aria-label="The crew">
            <Suspense fallback={null}>
              {recap ? (
                <CaptainRecapPage identity={identity} m={m} a={api} open={(sid) => (setRecap(false), onOpen(sid))} onBack={() => setRecap(false)} />
              ) : (
              <div className="cpt-crew">
                <div className="cpt-crew-tree">
                  <CaptainTree identity={identity} m={m} a={api} open={onOpen} onRecap={() => setRecap(true)} selected={sel} onSelect={(x, how) => (setSel(x), how === "pick" && setBottom(true))} onClear={() => setSel(null)} onLater={(at) => void api.answer(m.id, at, null)} />
                </div>
                <CrewPanel identity={identity} m={m} open={bottom} setOpen={setBottom} sel={sel} setSel={setSel} view={view} setView={setView} />
              </div>
              )}
            </Suspense>
          </section>
        </main>
      </CaptainChat>
      <CaptainSettings m={m} a={api} open={sheet} onClose={() => setSheet(false)} />
    </div>
  );
}

/** Arun's two panel marks (2026-11-27): a window with a panel down its left side (the chat), or along its foot (changes and cost).
 *  Drawn here rather than in icons.tsx, which every first screen loads. */
function PanelMark() {
  // Arun's bottom-panel mark (2026-11-27: "use these"), drawn as every icon of the app is (icons.tsx Icon, style.css svg.fi): its
  // line a crisp 1.4px whatever the size, never a smear across pixels ("all of the icons ... look grainy and blurry").
  return (
    <svg className="fi" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={`M3 15H21${BOX}`} />
    </svg>
  );
}

const BOX =
  "M7.8 3H16.2C17.8802 3 18.7202 3 19.362 3.32698C19.9265 3.6146 20.3854 4.07354 20.673 4.63803C21 5.27976 21 6.11984 21 7.8V16.2C21 17.8802 21 18.7202 20.673 19.362C20.3854 19.9265 19.9265 20.3854 19.362 20.673C18.7202 21 17.8802 21 16.2 21H7.8C6.11984 21 5.27976 21 4.63803 20.673C4.07354 20.3854 3.6146 19.9265 3.32698 19.362C3 18.7202 3 17.8802 3 16.2V7.8C3 6.11984 3 5.27976 3.32698 4.63803C3.6146 4.07354 4.07354 3.6146 4.63803 3.32698C5.27976 3 6.11984 3 7.8 3Z";
