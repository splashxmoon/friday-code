import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The empty state: an icon in a soft tile, a title, one or two lines saying what to do next, and at most one action. For a page
 * or a panel with nothing in it yet, or a thing that can't be shown.
 */
export function EmptyState({ icon, title, children, action, tone, className, small }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; /** Amber when it waits on the person, red when something is broken. */ tone?: "needs" | "bad"; className?: string; /** Inside a section of a page, under its 15px heading: a title that doesn't outrank it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */ small?: boolean }) {
  // The kit's EmptyState (components/affect/empty-state.tsx), bare: the page or panel around it is its frame. Drawn here with the
  // app's own stylesheet (chrome.css .ch-empty) rather than the kit's file, as it shows on the first screen.
  return (
    <div className={cn("ch-empty", className)} data-small={small || undefined} data-tone={tone}>
      {icon && (
        <span className="ch-empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="ch-empty-title">{title}</h2>
      {children && <div className="ch-empty-text">{children}</div>}
      {action && <div className="ch-empty-action">{action}</div>}
    </div>
  );
}
