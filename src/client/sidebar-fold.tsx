import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { reducedMotion } from "./presence.js";
import { loadFolded, saveFolded } from "./storage.js";

/**
 * What folds in the sidebar (a project's card, Needs you, Pinned, Recent, the Captains) opens and closes as one motion (Arun,
 * 2026-11-27: "iron out any laggy/buggy closing and opening of the project cards and stuff in the side bar"). The threads popped in
 * and out in one frame while the chevron turned on its own (or not at all), and the rows below slid back from where they had been.
 * Here the body's row of a grid goes 0fr↔1fr (sidebar-polish.css .sb-fold), the threads stay drawn until it has shut and leave after,
 * and with reduced motion it just opens and shuts.
 */
export function Fold({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const [was, setWas] = useState(open);
  // Its threads stay while it shuts, so they leave with the motion rather than before it.
  const [drawn, setDrawn] = useState(open);
  const [moving, setMoving] = useState(false);
  if (was !== open) {
    setWas(open);
    const still = reducedMotion();
    setMoving(!still);
    if (open || still) setDrawn(open);
  }
  const done = () => {
    setMoving(false);
    if (!open) setDrawn(false);
  };
  // Should its transitionend never come (the sidebar hidden mid-fold, say), it still ends.
  useEffect(() => {
    if (!moving) return;
    const t = setTimeout(() => (setMoving(false), !open && setDrawn(false)), 450);
    return () => clearTimeout(t);
  }, [moving, open]);
  return (
    <div
      className="sb-fold"
      id={id}
      data-open={open || undefined}
      data-fold-moving={moving || undefined}
      inert={!open}
      onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === "grid-template-rows" && done()}
    >
      <div className="sb-fold-in">{drawn && children}</div>
    </div>
  );
}

// Which of the list's groups are folded, held here so folding one draws that group alone: kept in SessionsList, every fold drew the
// whole list and every thread's row with it.
let folded: Set<string> | null = null;
const heard = new Set<() => void>();
const foldedNow = () => (folded ??= new Set(loadFolded()));
const listen = (f: () => void) => (heard.add(f), () => void heard.delete(f));

/** Whether the list's group `id` is open, drawn again only when it opens or folds. */
export const useGroupOpen = (id: string) => useSyncExternalStore(listen, () => !foldedNow().has(id));

export function flipGroup(id: string) {
  const next = new Set(foldedNow());
  if (!next.delete(id)) next.add(id);
  folded = next;
  saveFolded([...next]);
  for (const f of heard) f();
}
