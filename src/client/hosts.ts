import { useEffect, useState } from "react";

/**
 * Hosts in the page (local/hosts.ts, spec 15): your Fridays on other machines, opened here over SSH. In the desktop app the list
 * and the opening go through its bridge, so a host's own page (another origin, which can't ask this computer's Friday) shows the
 * same switcher; in a browser, this computer's page asks its Friday, and a host opens in a tab of its own.
 */
export type HostLink = "connecting" | "up" | "down";
export interface HostView {
  id: string;
  label: string;
  ssh: string;
  port: number;
  url: string;
  link: HostLink;
  addedAt: number;
  how?: "systemd" | "launchd" | "background";
  os?: string;
  warn?: string;
  error?: string;
  version?: string;
  name?: string;
  running?: number;
  lastSeen?: number;
}
export interface AddStep {
  id: "connect" | "install" | "service" | "open";
  state: "waiting" | "doing" | "done" | "failed";
  text: string;
}
export interface AddJob {
  id: string;
  ssh: string;
  steps: AddStep[];
  done: boolean;
  error?: string;
  host?: HostView;
  warn?: string;
}

/** The desktop app's side of it (preload.ts, host-preload.ts). */
export interface HostsBridge {
  list(): Promise<{ here: string | null; hosts: HostView[] }>;
  /** A host's window, or "here" for this computer's. */
  open(id: string): void;
  /** This computer's Settings › Other computers, from any window. */
  settings(): void;
  onChange(fn: () => void): () => void;
}

const bridge = (): HostsBridge | null => (window as { fridayDesktop?: { hosts?: HostsBridge } }).fridayDesktop?.hosts ?? null;

/** Which host this page is, in the desktop app (null: this computer's own). */
export const hereHost = (): Promise<string | null> => bridge()?.list().then((l) => l.here, () => null) ?? Promise.resolve(null);

export async function listHosts(): Promise<{ here: string | null; hosts: HostView[]; ssh?: string[]; available?: boolean }> {
  const b = bridge();
  if (b) return b.list();
  const r = await fetch("/api/hosts", { headers: { "x-friday-local": "1" } });
  if (!r.ok) return { here: null, hosts: [], available: false };
  const j = (await r.json()) as { hosts: HostView[]; ssh?: string[]; available?: boolean };
  return { here: null, ...j };
}

export function openHost(h: HostView | "here"): void {
  const b = bridge();
  if (b) return b.open(h === "here" ? "here" : h.id);
  // Through this Friday, which hands the browser on with a pass the host's Friday lets it in by (local/local-key.ts).
  if (h !== "here") window.open(`/api/hosts/${h.id}/open`, `friday-host-${h.id}`, "noopener");
}

export function openHostSettings(): void {
  const b = bridge();
  if (b) return b.settings();
  dispatchEvent(new CustomEvent("friday:settings", { detail: { tab: "other-computers" } }));
}

/** The hosts, kept current: every 15 s, sooner when the desktop app says one changed. */
export function useHosts(every = 15_000): { here: string | null; hosts: HostView[]; ssh: string[]; read: boolean; /** Hosts can be added from this page: this computer's own Friday, not a host's or one helping another. */ canAdd: boolean; reload: () => void } {
  const [got, setGot] = useState<{ here: string | null; hosts: HostView[]; ssh: string[]; read: boolean; canAdd: boolean }>({ here: null, hosts: [], ssh: [], read: false, canAdd: false });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const look = () =>
      void listHosts().then(
        (r) => live && setGot((was) => {
          const next = { here: r.here, hosts: r.hosts, ssh: r.ssh ?? was.ssh, read: true, canAdd: !r.here && r.available !== false };
          return JSON.stringify(next) === JSON.stringify(was) ? was : next;
        }),
        () => live && setGot((was) => ({ ...was, read: true })),
      );
    look();
    const t = setInterval(look, every);
    const off = bridge()?.onChange(look);
    return () => {
      live = false;
      clearInterval(t);
      off?.();
    };
  }, [every, n]);
  return { ...got, reload: () => setN((x) => x + 1) };
}

/** One line under a host's name: where it is and how it stands. */
export function hostLine(h: HostView): string {
  if (h.link === "down") return h.error ?? "Can't reach it";
  if (h.link === "connecting") return h.error ?? "Connecting…";
  const running = h.running ? `${h.running} running` : "Nothing running";
  return [running, h.ssh].filter(Boolean).join(" · ");
}
