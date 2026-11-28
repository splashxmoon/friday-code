import { Icon } from "./icons.js";
import { hostLine, openHost, openHostSettings, useHosts } from "./hosts.js";
import { MenuButton } from "./ui.js";

/** This computer's own name in the switcher: "This Mac" as the mock had it, "This PC" on Windows. */
const hereName = (): string => (/Mac/i.test(navigator.platform) ? "This Mac" : /Win/i.test(navigator.platform) ? "This PC" : "This computer");

/**
 * Which Friday this window is, at the top of the sidebar, and a press to another (spec 15, the host switcher): this computer's and
 * each host's, with what runs there; a host's window says so here, so it's never unclear which one you're working in. Shown once
 * there is a host, or in a host's own window.
 */
export function HostSwitcher() {
  const { here, hosts, read } = useHosts();
  if (!read || (!hosts.length && !here)) return null;
  const now = here ? hosts.find((h) => h.id === here) : undefined;
  const runningElsewhere = hosts.filter((h) => h.id !== here && (h.running ?? 0) > 0).reduce((a, h) => a + (h.running ?? 0), 0);
  const meta = now ? (now.link === "up" ? (now.running ? `${now.running} running` : "") : now.link === "down" ? "Can't reach it" : "Connecting…") : runningElsewhere ? `${runningElsewhere} running on hosts` : "";
  return (
    <MenuButton
      className={`sb-host${now ? " on-host" : ""}`}
      label={`Which Friday: ${now ? now.label : hereName()}. Switch to another`}
      width={260}
      items={() => [
        { heading: "Open" },
        { label: hereName(), icon: "columns", sub: "Your own Friday, on this computer", checked: !now, onSelect: () => !!now && openHost("here") },
        ...hosts.map((h) => ({
          label: h.label,
          icon: "server" as const,
          sub: hostLine(h),
          checked: h.id === here,
          live: (h.running ?? 0) > 0,
          disabled: h.link !== "up" && h.id !== here,
          onSelect: () => h.id !== here && openHost(h),
        })),
        { label: hosts.length ? "Manage computers" : "Add a computer", icon: hosts.length ? "settings" : "plus", onSelect: openHostSettings },
      ]}
    >
      <span className="sb-host-mark" aria-hidden>
        <Icon name={now ? "server" : "columns"} size={13} />
      </span>
      <span className="sb-host-name">{now ? now.label : hereName()}</span>
      {meta && <span className={`sb-host-meta${now?.link === "down" ? " bad" : ""}`}>{meta}</span>}
      <Icon name="chevronDown" size={13} className="sb-host-caret" />
    </MenuButton>
  );
}
