/**
 * A host's window's bridge (desktop-hosts.ts, spec 15): its page is another machine's Friday, so it gets only what lays it out as
 * the app (the macOS window buttons, full screen, its theme for the window's buttons, waking) and the host switcher's list and
 * presses. Nothing that reaches this computer: no shell, files, folder picker, editor, browser tabs or updates (preload.ts has
 * those for this computer's own page). Its terminal, files and previews are the host's, through its page as in a browser.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fridayDesktop", {
  platform: process.platform,
  trafficLightY: 14,
  /** A host's window: the page knows not to offer this computer's own things (a local shell, Open in editor). */
  remoteHost: true,
  onFullScreen: (fn: (full: boolean) => void): (() => void) => {
    const h = (_e: unknown, full: boolean) => fn(full);
    ipcRenderer.on("friday:full-screen", h);
    return () => void ipcRenderer.off("friday:full-screen", h);
  },
  setTheme: (theme: "dark" | "light"): void => ipcRenderer.send("friday:host-theme", theme),
  onResume: (fn: () => void): (() => void) => {
    const h = () => fn();
    ipcRenderer.on("friday:resume", h);
    return () => void ipcRenderer.off("friday:resume", h);
  },
  hosts: {
    list: (): Promise<unknown> => ipcRenderer.invoke("friday:hosts-list"),
    open: (id: string): void => ipcRenderer.send("friday:host-open", id),
    settings: (): void => ipcRenderer.send("friday:hosts-settings"),
    retry: (): void => ipcRenderer.send("friday:host-retry"),
    onChange: (fn: () => void): (() => void) => {
      const h = () => fn();
      ipcRenderer.on("friday:hosts-changed", h);
      return () => void ipcRenderer.off("friday:hosts-changed", h);
    },
  },
});
