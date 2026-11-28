/**
 * Hosts in the desktop app (spec 15, hosts.ts): each host's Friday in a window of its own, opened over its SSH tunnel at
 * http://127.0.0.1:<port>, and the switcher's list and presses for every window.
 *
 * A host's page is another machine's Friday. It gets a bridge of its own (host-preload.ts) that lays the page out as the app and
 * lists and opens hosts, and nothing that reaches this computer: no shell, no files, no folder picker, no editor (the main
 * window's preload.ts has those for this computer's own page). Its terminal, files and previews are the host's own, through its
 * page as in a browser. Its webviews are locked as the main window's are, and it never navigates away from its own address.
 */
import { BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";
import { MAC_CSS, THEME_WATCH, WIN_CSS } from "../desktop-chrome.js";
import { KEY_HEADER } from "./local-key.js";
import { isOwnUrl } from "./own-url.js";

type HostView = { id: string; label: string; url: string; link: string; port: number };

const OVERLAY = {
  dark: { color: "#00000000", symbolColor: "#ededed", height: 38 },
  light: { color: "#00000000", symbolColor: "#18181b", height: 38 },
} as const;
const WINDOW_BG = { dark: "#1c1c1c", light: "#fafaf9" } as const;

export function registerHosts(o: {
  /** This computer's Friday's address, once it runs. */
  appUrl: () => string | null;
  /** Its key (local-key.ts), which it asks of every request. */
  key: () => string;
  /** This computer's own window: shown and focused, made if it isn't there. */
  showMain: () => BrowserWindow | null;
  /** The folder the bridges are built into (dist/). */
  dir: string;
}): { kick: () => void } {
  const windows = new Map<string, BrowserWindow>();
  const idOf = (wc: Electron.WebContents): string | null => {
    for (const [id, w] of windows) if (!w.isDestroyed() && w.webContents === wc) return id;
    return null;
  };
  const ask = async <T>(p: string, init?: RequestInit): Promise<T> => {
    const base = o.appUrl();
    if (!base) throw new Error("Friday isn't running.");
    const r = await fetch(`${base}${p}`, { ...init, signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json", [KEY_HEADER]: o.key() } });
    return (await r.json()) as T;
  };
  /** A host's address with a pass its Friday lets this window in by (hosts.ts enterUrl), else its plain one. */
  const enter = (h: HostView) => ask<{ url?: string }>(`/api/hosts/${h.id}/enter`).then((r) => (typeof r.url === "string" && isOwnUrl(r.url, h.url) ? r.url : h.url), () => h.url);
  const list = () => ask<{ hosts: HostView[] }>("/api/hosts").then((r) => r.hosts ?? [], () => [] as HostView[]);
  const changed = () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("friday:hosts-changed");
  };

  const open = async (id: string, from?: BrowserWindow | null) => {
    if (id === "here") {
      const m = o.showMain();
      if (m && from && !from.isDestroyed() && from !== m) m.setBounds(from.getBounds());
      return;
    }
    const h = (await list()).find((x) => x.id === id);
    if (!h) return;
    let w = windows.get(id);
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
      return w.focus();
    }
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    const near = from && !from.isDestroyed() ? from.getBounds() : undefined;
    w = new BrowserWindow({
      ...(near ? { x: near.x, y: near.y, width: near.width, height: near.height } : { width: 1440, height: 920 }),
      minWidth: 1100,
      minHeight: 700,
      title: `Friday · ${h.label}`,
      backgroundColor: WINDOW_BG[theme],
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
        : { titleBarStyle: "hidden" as const, titleBarOverlay: OVERLAY[theme] }),
      // A jar of its own (persist:hosts): its permissions refused below without touching this computer's own window's.
      webPreferences: { contextIsolation: true, sandbox: true, webviewTag: true, partition: "persist:hosts", preload: path.join(o.dir, "host-preload.cjs") },
    });
    windows.set(id, w);
    const own = (u: string) => isOwnUrl(u, h.url);
    w.webContents.on("will-attach-webview", (_e, prefs) => {
      prefs.partition = "persist:preview";
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.sandbox = true;
      prefs.contextIsolation = true;
      delete prefs.preload;
    });
    w.webContents.setWindowOpenHandler(({ url: u }) => {
      if (!own(u) && /^https?:/.test(u)) void shell.openExternal(u);
      return { action: "deny" };
    });
    w.webContents.on("will-navigate", (e, u) => {
      if (own(u)) return;
      e.preventDefault();
      if (/^https?:/.test(u)) void shell.openExternal(u);
    });
    w.webContents.on("will-frame-navigate", (e) => {
      if (e.isMainFrame || /^about:/i.test(e.url)) return;
      if (own(e.url) && new URL(e.url).pathname.startsWith("/api/local/backdrops/f/")) return;
      const f = e.frame;
      if (f && (f.url === "about:srcdoc" || f.origin === "null")) e.preventDefault();
    });
    // Its permissions: none it asks for (a host's page is another machine's; the microphone is this one's own window's).
    w.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    w.webContents.session.setPermissionCheckHandler(() => false);
    w.once("ready-to-show", () => w?.show());
    const sayFull = () => w && !w.isDestroyed() && w.webContents.send("friday:full-screen", w.isFullScreen());
    w.on("enter-full-screen", sayFull);
    w.on("leave-full-screen", sayFull);
    w.webContents.on("did-finish-load", () => {
      if (!w || w.isDestroyed() || w.webContents.getURL().startsWith("data:")) return;
      void w.webContents.insertCSS(process.platform === "darwin" ? MAC_CSS : WIN_CSS);
      void w.webContents.executeJavaScript(THEME_WATCH).catch(() => {});
    });
    // Down: its own page about it, with Reconnect, rather than Chromium's.
    w.webContents.on("did-fail-load", (_e, code, _desc, url, main) => {
      if (!main || code === -3 || !w || w.isDestroyed()) return;
      void w.loadURL(downPage(h.label, url.replace(/#.*$/, ""))).catch(() => {});
    });
    w.on("page-title-updated", (e) => e.preventDefault());
    w.on("closed", () => windows.delete(id));
    void enter(h).then((to) => void (w && !w.isDestroyed() && w.loadURL(to).catch(() => {})));
  };

  // A host's own page (another machine's) is told only what its switcher shows of the others: their names and how they stand,
  // never their SSH addresses, systems or ports. This computer's page gets it all, for Settings › Hosts.
  ipcMain.handle("friday:hosts-list", async (e) => {
    const here = idOf(e.sender);
    const hs = await list();
    return { here, hosts: here ? hs.map((h) => ({ id: h.id, label: h.label, link: h.link, ...("running" in h ? { running: (h as { running?: number }).running } : {}), ssh: "", url: "", port: 0, addedAt: 0 })) : hs };
  });
  ipcMain.on("friday:host-open", (e, id: unknown) => {
    if (typeof id !== "string" || !/^(here|[0-9a-f]{12})$/.test(id)) return;
    void open(id, BrowserWindow.fromWebContents(e.sender));
  });
  ipcMain.on("friday:hosts-settings", () => {
    const m = o.showMain();
    void m?.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("friday:settings",{detail:{tab:"hosts"}}))`).catch(() => {});
  });
  // A host window's down page: Reconnect asks this computer's Friday to try its tunnel again, then loads the host once more.
  ipcMain.on("friday:host-retry", (e) => {
    const id = idOf(e.sender);
    const w = id ? windows.get(id) : null;
    if (!id || !w) return;
    void ask(`/api/hosts/${id}/reconnect`, { method: "POST" })
      .catch(() => {})
      .then(() => list())
      .then((hs) => {
        const h = hs.find((x) => x.id === id);
        if (h && !w.isDestroyed()) setTimeout(() => void enter(h).then((to) => void (!w.isDestroyed() && w.loadURL(to).catch(() => {}))), 1500);
      });
  });
  // A host window's light or dark page: its window buttons follow, on Windows and Linux.
  ipcMain.on("friday:host-theme", (e, theme: unknown) => {
    const id = idOf(e.sender);
    const w = id ? windows.get(id) : null;
    if (!w || w.isDestroyed()) return;
    const which = theme === "light" ? "light" : "dark";
    try {
      w.setBackgroundColor(WINDOW_BG[which]);
      if (process.platform !== "darwin") w.setTitleBarOverlay(OVERLAY[which]);
    } catch {
      // Not every platform draws an overlay.
    }
  });
  // The list changing (a host added, up or down): every window's switcher reads it again, every 15 s anyway.
  let last = "";
  setInterval(() => {
    void list().then((hs) => {
      const now = JSON.stringify(hs.map((h) => [h.id, h.label, h.link]));
      if (now !== last) {
        last = now;
        changed();
      }
      // A window on a host that went: closed.
      for (const [id, w] of windows) if (!hs.some((h) => h.id === id) && !w.isDestroyed()) w.close();
    });
  }, 5_000).unref();
  return {
    // This computer back from sleep: every host's tunnel tried again at once.
    kick: () => void list().then((hs) => Promise.all(hs.map((h) => ask(`/api/hosts/${h.id}/reconnect`, { method: "POST" }).catch(() => {})))),
  };
}

/** A host's window while it can't be reached: what happened, and Reconnect. */
function downPage(label: string, url: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><title>Friday · ${esc(label)}</title>
<style>:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:17px;margin:0 0 6px}p{margin:0 0 16px;opacity:.7}
button{font:inherit;font-weight:500;padding:7px 14px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);background:Canvas;color:CanvasText;cursor:pointer}</style>
<main><h1>Can't reach ${esc(label)} right now</h1><p>Its Friday keeps running there. This window opens it again once this computer can reach it (${esc(new URL(url).host)}).</p>
<button onclick="window.fridayDesktop&&window.fridayDesktop.hosts&&window.fridayDesktop.hosts.retry()">Reconnect</button></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
