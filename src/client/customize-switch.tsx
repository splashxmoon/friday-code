import { useEffect, useState } from "react";
import { SegmentedControl } from "@/components/affect/segmented-control";
import { Icon } from "./icons.js";

/**
 * Customize's switch, Plugins or Skills, at the start of whichever is open's one header line, each side with its count (Arun,
 * 2026-11-27, the approved Customize mock: "good!"). It was a row of its own above the search, a size up (2026-11-20: "make the
 * MCP and Skills toggle more visible"); the mock puts it in the header line, the kit's tray. Loaded with the page, not the app: the
 * first screen's budget is spent (test/client-bundle.test.ts).
 */
export type CustomizeTab = "mcp" | "skills";

/** The tab last open, where the rail's Customize button goes back to (App.tsx reads it). */
const TAB = "friday.customize.tab";
/** Each side's count from when it was last read, so the other side's shows before that page is opened again. */
const COUNTS = "friday.customize.counts";

function keptCounts(): Partial<Record<CustomizeTab, number>> {
  try {
    const raw = JSON.parse(localStorage.getItem(COUNTS) ?? "{}") as Partial<Record<CustomizeTab, unknown>>;
    return Object.fromEntries(Object.entries(raw).filter(([, n]) => typeof n === "number")) as Partial<Record<CustomizeTab, number>>;
  } catch {
    return {};
  }
}

export function CustomizeSwitch({ tab, onTab, count }: { tab: CustomizeTab; onTab: (tab: CustomizeTab) => void; /** This side's count, once read. */ count?: number }) {
  const [kept] = useState(keptCounts);
  useEffect(() => {
    try {
      localStorage.setItem(TAB, tab);
      if (count !== undefined) localStorage.setItem(COUNTS, JSON.stringify({ ...keptCounts(), [tab]: count }));
    } catch {
      /* Remembered for this window only. */
    }
  }, [tab, count]);
  const n = { ...kept, ...(count !== undefined ? { [tab]: count } : {}) };
  return (
    <SegmentedControl<CustomizeTab>
      kind="tabs"
      variant="tray"
      aria-label="Customize"
      className="cz-switch"
      value={tab}
      onChange={onTab}
      options={[
        { value: "mcp", label: "Plugins", icon: <Icon name="plug" size={13} />, count: n.mcp },
        { value: "skills", label: "Skills", icon: <Icon name="book" size={13} />, count: n.skills },
      ]}
    />
  );
}
