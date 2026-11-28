/**
 * Hosts: a Friday of yours running on another machine, as a service, that this one opens in a window of its own (Arun,
 * 2026-11-26: "Next is remote machines, we need proper infrastructure and setup for this to work"; spec 15, Friday Work HQ
 * product/specs/15-remote-hosts.md).
 *
 * A linked computer (join.ts) works for this Friday: its agents dial in here, so they stop a few minutes after this computer sleeps.
 * A host is a whole Friday of its own on the box: its sessions, Captains, crew, automations and sign-ins live there and keep
 * going with this laptop shut. This computer is only a window onto it, over SSH:
 *
 * - Added over SSH (this computer's own ssh: ~/.ssh/config, keys, agent): the same Friday as this one is carried there and
 *   installed into ~/.friday-host (no sudo), then run as a service (systemd user unit with linger, a launchd agent, or in the
 *   background), headless, answering only 127.0.0.1 on a port picked free on both ends.
 * - Reached through `ssh -N -L P:127.0.0.1:P`: the same port number here as there, so to the box's server the page is its own
 *   (its address, its checks of Origin, its previews at localhost:P) and nothing about it is open to the network. Kept up,
 *   reconnecting with backoff, and asked every so often how it is (/api/host/status).
 * - Removed: its service stopped and its program taken off; its data (sessions, settings) stays on the box, said so.
 *
 * Nothing goes through Friday's servers, and no sign-in is copied: Claude Code and the rest are signed in to on the box itself,
 * from its own Friday (account safety: a login stays with the machine it was made on).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { objectShape, readJson, updateJson } from "../safe-file.js";
import { FIND_NODE, PACKAGE, SSH_HOST, sshConfigHosts } from "./add-computer.js";
import { enterLink, KEY_FILE } from "./local-key.js";

export interface HostRecord {
  id: string;
  /** What the person calls it ("Hetzner"); the ssh host until renamed. */
  label: string;
  /** What `ssh` is given: an alias from ~/.ssh/config, a name, or user@host. */
  ssh: string;
  /** The port its Friday answers on there, and the tunnel's here: the same number at both ends. */
  port: number;
  addedAt: number;
  /** How its service runs there. */
  how?: "systemd" | "launchd" | "background";
  /** Its system, as it said when it was set up ("Linux 6.8.0 x86_64"). */
  os?: string;
  /** Said when it was set up: it stops when the person logs out there (no linger), or won't come back after a restart. */
  warn?: string;
}

export type HostLink = "connecting" | "up" | "down";

export interface HostView extends HostRecord {
  /** The address its Friday is opened at here, through the tunnel. */
  url: string;
  link: HostLink;
  /** Why it isn't up, in words for the person. */
  error?: string;
  /** What its Friday said last time it was asked. */
  version?: string;
  name?: string;
  running?: number;
  lastSeen?: number;
}

/** A step of adding one, as Settings › Other computers lists them. */
export type AddStep = { id: "connect" | "install" | "service" | "open"; state: "waiting" | "doing" | "done" | "failed"; text: string };
export interface AddJob {
  id: string;
  ssh: string;
  steps: AddStep[];
  done: boolean;
  error?: string;
  /** The host made, once it is up. */
  host?: HostView;
  warn?: string;
}

type Store = { hosts?: HostRecord[] };

const ID = /^[0-9a-f]{12}$/;
/** Ports a host is offered on, in turn from one picked by its id: clear of Friday's own 4321 and of common dev servers. */
const PORT_BASE = 4400;
const PORT_SPAN = 400;

/** The lines a host's setup prints, read by addResult: FRIDAY_STEP, FRIDAY_OS, FRIDAY_INSTALLED, FRIDAY_UP, FRIDAY_DONE, FRIDAY_ERROR. */
export function hostScript(o: { part: "install" | "service" | "remove"; pkg?: string; ports?: number[]; label?: string; env?: Record<string, string> }): string {
  const label = (o.label ?? "").replace(/[^\w .-]/g, "").slice(0, 40) || "a host";
  const head = `set -e
say() { printf '%s\\n' "$*"; }
${FIND_NODE}DIR="$HOME/.friday-host"
BIN="$DIR/node_modules/.bin/friday"
say "FRIDAY_OS $(uname -srm)"
`;
  // Its service stopped wherever it runs: systemd, launchd, or the background (its pid in running.json). Before a new install (a
  // host added again, or updated) and on removal.
  const stop = `if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now friday-host.service >/dev/null 2>&1 || true
fi
if [ "$(uname -s)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/com.tryfriday.host" >/dev/null 2>&1 || launchctl unload "$HOME/Library/LaunchAgents/com.tryfriday.host.plist" >/dev/null 2>&1 || true
fi
if [ -f "$DIR/data/running.json" ]; then
  PID=$("$NODE" -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||""))}catch{}' "$DIR/data/running.json")
  [ -n "$PID" ] && kill "$PID" >/dev/null 2>&1 || true
  sleep 1
fi
`;
  if (o.part === "remove")
    return `${head}${stop}rm -f "$HOME/.config/systemd/user/friday-host.service" "$HOME/Library/LaunchAgents/com.tryfriday.host.plist"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
rm -rf "$DIR/node_modules" "$DIR/package.json" "$DIR/package-lock.json" "$DIR/friday.tgz"
say "FRIDAY_REMOVED"
`;
  if (o.part === "install") {
    // The same Friday as this computer's, carried there as a package (friday.tgz, sent before this runs), else the public one.
    const pkg = o.pkg && /^[\w./~-]+$/.test(o.pkg) ? o.pkg : PACKAGE;
    return `${head}git --version >/dev/null 2>&1 || { say "FRIDAY_ERROR no-git"; exit 24; }
mkdir -p "$DIR"
chmod 700 "$DIR"
say "FRIDAY_STEP install"
${stop}PKG="${pkg}"
case "$PKG" in ./*) PKG="$DIR/\${PKG#./}" ;; esac
PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$DIR" --no-audit --no-fund --loglevel=error "$PKG" >"$DIR/install.log" 2>&1 || { tail -n 20 "$DIR/install.log"; say "FRIDAY_ERROR install"; exit 25; }
[ -e "$BIN" ] || { say "FRIDAY_ERROR install"; exit 25; }
say "FRIDAY_INSTALLED $("$NODE" -p 'require(process.argv[1]).version' "$DIR/node_modules/friday-work/package.json" 2>/dev/null || echo '?')"
`;
  }
  // The service: a port free there from the ones offered (free here too), then Friday run headless on it, and waited for.
  const ports = (o.ports ?? []).filter((p) => Number.isInteger(p) && p > 1024 && p < 65536).join(" ");
  const extra = Object.entries(o.env ?? {})
    .filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && /^[\w.:/-]*$/.test(v))
    .map(([k, v]) => `${k}=${v}`);
  const envs = [`FRIDAY_HOME=$DIR/data`, `PORT=$PORT`, "FRIDAY_SERVICE=1", "FRIDAY_NO_OPEN=1", "FRIDAY_HOST=1", ...extra];
  return `${head}[ -e "$BIN" ] || { say "FRIDAY_ERROR install"; exit 25; }
say "FRIDAY_STEP service"
${stop}PORT=$("$NODE" -e '
const net = require("net");
const free = (p, h) => new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.listen(p, h, () => s.close(() => r(true))); });
(async () => { for (const p of process.argv.slice(1).map(Number)) if ((await free(p, "127.0.0.1")) && (await free(p, "::1").catch(() => true))) { process.stdout.write(String(p)); return; } process.exit(1); })();
' ${ports}) || { say "FRIDAY_ERROR no-port"; exit 26; }
mkdir -p "$DIR/data"
rm -f "$DIR/data/running.json"
LOG="$DIR/friday.log"
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/friday-host.service"
  mkdir -p "$(dirname "$UNIT")"
  {
    printf '[Unit]\\nDescription=Friday, as a host for %s\\nAfter=network-online.target\\n\\n' '${label}'
    printf '[Service]\\nEnvironment="PATH=%s"' "$(dirname "$NODE"):$PATH"
    for e in ${envs.map((e) => `"${e}"`).join(" ")}; do printf ' "%s"' "$e"; done
    printf '\\nWorkingDirectory=%s\\nExecStart="%s" "%s" --no-open\\nRestart=on-failure\\nRestartSec=5\\nStandardOutput=append:%s\\nStandardError=append:%s\\n\\n[Install]\\nWantedBy=default.target\\n' "$HOME" "$NODE" "$BIN" "$LOG" "$LOG"
  } > "$UNIT"
  chmod 600 "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now friday-host.service >/dev/null 2>&1
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || say "FRIDAY_WARN linger"
  HOW=systemd
elif [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.tryfriday.host.plist"
  mkdir -p "$(dirname "$PLIST")"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n'
    printf '<plist version="1.0"><dict>\\n<key>Label</key><string>com.tryfriday.host</string>\\n'
    printf '<key>ProgramArguments</key><array><string>%s</string><string>%s</string><string>--no-open</string></array>\\n' "$NODE" "$BIN"
    printf '<key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string>' "$(dirname "$NODE"):$PATH"
    for e in ${envs.map((e) => `"${e}"`).join(" ")}; do printf '<key>%s</key><string>%s</string>' "\${e%%=*}" "\${e#*=}"; done
    printf '</dict>\\n<key>WorkingDirectory</key><string>%s</string>\\n<key>RunAtLoad</key><true/>\\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\\n' "$HOME"
    printf '<key>StandardOutPath</key><string>%s</string>\\n<key>StandardErrorPath</key><string>%s</string>\\n</dict></plist>\\n' "$LOG" "$LOG"
  } > "$PLIST"
  chmod 600 "$PLIST"
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1; then HOW=launchd
  else
    cd "$HOME"
    env ${envs.join(" ")} nohup "$NODE" "$BIN" --no-open >> "$LOG" 2>&1 &
    HOW=background
  fi
else
  cd "$HOME"
  env ${envs.join(" ")} nohup "$NODE" "$BIN" --no-open >> "$LOG" 2>&1 &
  HOW=background
fi
# Up when its own running.json says where it answers and that address says it's Friday: its first start builds its page.
UP=""
i=0
while [ $i -lt 240 ]; do
  if [ -f "$DIR/data/running.json" ]; then
    UP=$("$NODE" -e '
const f = require("fs"), url = JSON.parse(f.readFileSync(process.argv[1], "utf8")).url;
fetch(url + "/api/host/status", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => { if (j && j.version) process.stdout.write(new URL(url).port + " " + j.version); }, () => {});
' "$DIR/data/running.json" 2>/dev/null || true)
    [ -n "$UP" ] && break
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "$UP" ] || { tail -n 15 "$LOG" 2>/dev/null; say "FRIDAY_ERROR not-up"; exit 27; }
say "FRIDAY_UP $UP"
say "FRIDAY_DONE $HOW"
`;
}

/** What a host's setup said, in words for the person: the port it came up on and how it runs, or why it didn't. */
export function hostResult(out: string, ssh: string): { ok: true; port: number; version: string; how: "systemd" | "launchd" | "background"; os?: string; warn?: string } | { ok: false; error: string } {
  const os = out.match(/^FRIDAY_OS (.+)$/m)?.[1]?.trim();
  const up = out.match(/^FRIDAY_UP (\d+) (\S+)$/m);
  const done = out.match(/^FRIDAY_DONE (systemd|launchd|background)$/m);
  if (up && done) {
    const how = done[1] as "systemd" | "launchd" | "background";
    const warn = /^FRIDAY_WARN linger$/m.test(out)
      ? `It stops when you log out of ${ssh}, unless someone with admin rights there runs: sudo loginctl enable-linger $USER`
      : how === "background"
        ? `It runs in the background on ${ssh}, but won't come back by itself after the machine restarts. Update it from here after one.`
        : undefined;
    return { ok: true, port: Number(up[1]), version: up[2]!, how, ...(os ? { os } : {}), ...(warn ? { warn } : {}) };
  }
  if (/^FRIDAY_ERROR no-port$/m.test(out)) return { ok: false, error: `None of the ports Friday offered is free on ${ssh}.` };
  if (/^FRIDAY_ERROR not-up$/m.test(out)) {
    const tail = out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("FRIDAY_") && !/Warning|--trace-/.test(l)).slice(-2).join(" / ").slice(0, 300);
    return { ok: false, error: `Friday was installed on ${ssh} but didn't start within four minutes.${tail ? ` Its log: ${tail}` : ""}` };
  }
  // The rest is the same as setting up a linked computer: Node, npm, git, keys, names, a refused host key.
  const old = out.match(/^FRIDAY_ERROR old-node (\d+)$/m);
  if (old) return { ok: false, error: `${ssh} has Node ${old[1]}. Friday needs Node 22 or newer there: update it, then try again.` };
  if (/^FRIDAY_ERROR no-node$/m.test(out)) return { ok: false, error: `${ssh} doesn't have Node. Install Node 22 or newer there, then try again.` };
  if (/^FRIDAY_ERROR no-npm$/m.test(out)) return { ok: false, error: `${ssh} has Node but no npm beside it. Install Node from nodejs.org there, then try again.` };
  if (/^FRIDAY_ERROR no-git$/m.test(out)) return { ok: false, error: `${ssh} doesn't have git, which Friday needs. Install it there, then try again.` };
  if (/^FRIDAY_ERROR install$/m.test(out)) return { ok: false, error: `Friday couldn't be installed on ${ssh}: ${out.split("\n").filter((l) => l.trim() && !/^FRIDAY_/.test(l)).slice(-2).join(" ").slice(0, 300) || "npm said no"}` };
  if (/Permission denied|publickey/i.test(out)) return { ok: false, error: `${ssh} didn't accept your key. If your key has a passphrase, run ssh-add once so it's remembered, then try again. Check you can run ssh ${ssh} in a terminal.` };
  if (/Could not resolve hostname|Name or service not known/i.test(out)) return { ok: false, error: `Couldn't find ${ssh}. Check the name, or add it to your ~/.ssh/config.` };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out)) return { ok: false, error: `${ssh}'s identity has changed since you last connected, so Friday stopped. If you expected that, update ~/.ssh/known_hosts, then try again.` };
  if (/Host key verification failed/i.test(out)) return { ok: false, error: `${ssh}'s key couldn't be checked. Run ssh ${ssh} once in a terminal and accept its key, then try again.` };
  if (/timed out|Connection refused|No route to host/i.test(out)) return { ok: false, error: `Couldn't reach ${ssh}. Check it's on and that SSH is open, then try again.` };
  if (/'sh' is not recognized|is not recognized as an internal or external command/i.test(out)) return { ok: false, error: `${ssh} looks like a Windows machine. Hosts run on macOS and Linux.` };
  const last = out.trim().split(/\r?\n/).filter((l) => !l.startsWith("FRIDAY_")).slice(-3).join(" ").slice(0, 300);
  return { ok: false, error: `Setting up ${ssh} didn't finish${last ? `: ${last}` : "."}` };
}

/** Why a tunnel's ssh ended, in words for the person, from what it said. */
export function tunnelError(said: string, ssh: string, port: number): string {
  if (/Address already in use|cannot listen to port|bind.*failed/i.test(said)) return `Port ${port} is taken on this computer by something else, so ${ssh} can't be opened here. Quit what's using it, or update the host to move it.`;
  if (/Permission denied|publickey/i.test(said)) return `${ssh} didn't accept your key. If it has a passphrase, run ssh-add once, then reconnect.`;
  if (/Could not resolve hostname|Name or service not known/i.test(said)) return `Couldn't find ${ssh}. Is this computer online?`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(said)) return `${ssh}'s identity has changed since it was added, so Friday won't connect. If you expected that, update ~/.ssh/known_hosts.`;
  if (/timed out|Connection refused|No route to host|Network is unreachable/i.test(said)) return `Can't reach ${ssh} right now. It may be off or this computer offline.`;
  const last = said.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 200);
  return last ? `The connection to ${ssh} closed: ${last}` : `The connection to ${ssh} closed.`;
}

/** Whether a port answers nothing here, on 127.0.0.1 and ::1, so a tunnel can take it. */
async function freeHere(port: number): Promise<boolean> {
  const one = (h: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
      s.listen(port, h, () => s.close(() => resolve(true)));
    });
  return (await one("127.0.0.1")) && (await one("::1"));
}

/** The package carried to a host: the same Friday as this one, never the hosted product's code. */
export async function hostPackage(): Promise<{ file: string } | { spec: string }> {
  const given = process.env.FRIDAY_HOST_PACKAGE;
  // "public": the published package by name, whatever this copy is (the tests, so a clone of the public repo, which would pack
  // itself, runs them the same as this one; 2026-11-27, v0.4.5's public suite).
  if (given === "public") return { spec: PACKAGE };
  if (given && existsSync(given)) return { file: given };
  // The desktop app carries it beside itself (scripts/build-local-desktop.mts).
  const res = (process as { resourcesPath?: string }).resourcesPath;
  const bundled = res ? path.join(res, "host-package", "friday.tgz") : "";
  if (bundled && existsSync(bundled)) return { file: bundled };
  // Run from the open-source package itself (npx, a clone of it): packed from where it is.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
    if (pkg.name === "friday-work" && existsSync(path.join(root, "src", "local", "main.ts"))) {
      const out = await mkdtemp(path.join(tmpdir(), "friday-host-pack-"));
      const file = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--silent", "--pack-destination", out, root], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
        let said = "";
        child.stdout.on("data", (d: Buffer) => (said += d.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 && said.trim() ? resolve(path.join(out, said.trim().split(/\r?\n/).pop()!)) : reject(new Error("npm pack failed"))));
      });
      return { file };
    }
  } catch {
    // Not packable here: the public one.
  }
  return { spec: PACKAGE };
}

type SshRun = (args: string[], o: { stdin?: string | NodeJS.ReadableStream; ms: number }) => Promise<{ code: number | null; out: string }>;

/** ssh as this computer's own: its config (or the one FRIDAY_SSH_CONFIG names, for a test), keys and agent; never a password prompt. */
export function sshArgs(): string[] {
  const cfg = process.env.FRIDAY_SSH_CONFIG;
  return [...(cfg ? ["-F", cfg] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"];
}

const runSsh: SshRun = (args, o) =>
  new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgs(), ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const take = (d: Buffer) => void (out = (out + d.toString("utf8")).slice(-40_000));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), o.ms);
    child.on("error", (e: Error) => (clearTimeout(timer), resolve({ code: null, out: `${out}\n${e.message}` })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
    child.stdin.on("error", () => {});
    if (typeof o.stdin === "string" || o.stdin === undefined) child.stdin.end(o.stdin ?? "");
    else o.stdin.pipe(child.stdin);
  });

/** Every tunnel's ssh, ended when this process ends however it ends: one left behind would hold its port with nobody to stop it. */
const alive = new Set<ChildProcess>();
let hooked = false;
function endWithUs(c: ChildProcess): void {
  alive.add(c);
  c.on("close", () => alive.delete(c));
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const x of alive) x.kill("SIGTERM");
  });
}

/** One host's tunnel: `ssh -N -L P:127.0.0.1:P`, kept up while this Friday runs, and asked how its Friday is. */
class Tunnel {
  link: HostLink = "connecting";
  error = "";
  version = "";
  name = "";
  running = 0;
  lastSeen = 0;
  private child: ChildProcess | null = null;
  private stopped = false;
  private wait = 2_000;
  private retry: NodeJS.Timeout | null = null;
  private ask: NodeJS.Timeout | null = null;
  private said = "";

  constructor(
    readonly host: HostRecord,
    private readonly onChange: () => void,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.child) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.set("connecting", "");
    void this.open();
  }

  private async open(): Promise<void> {
    const { port, ssh } = this.host;
    // A port taken here is said before ssh tries it, rather than read from its error.
    if (!(await freeHere(port))) {
      // Ours already, from a tunnel that outlived its Friday? Then it's that host answering: asked, it says.
      if (await this.check()) return this.schedule();
      this.set("down", tunnelError("Address already in use", ssh, port));
      return this.again();
    }
    if (this.stopped) return;
    const child = spawn("ssh", [...sshArgs(), "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", `${port}:127.0.0.1:${port}`, "--", ssh], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child = child;
    endWithUs(child);
    this.said = "";
    child.stderr?.on("data", (d: Buffer) => void (this.said = (this.said + d.toString("utf8")).slice(-4_000)));
    child.on("error", (e) => void (this.said += `\n${e.message}`));
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.ask) clearTimeout(this.ask);
      this.ask = null;
      if (this.stopped) return;
      this.set("down", tunnelError(this.said, ssh, port));
      this.log(`[hosts] ${this.host.label}: tunnel closed (${this.said.trim().split("\n").pop() ?? ""})`);
      this.again();
    });
    // Up once its Friday answers through it: ssh says nothing when a forward is ready.
    for (let n = 0; n < 40 && this.child === child; n++) {
      if (await this.check()) {
        this.wait = 2_000;
        return this.schedule();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.child === child && this.link !== "up") this.set("connecting", `Connected to ${ssh}, but its Friday isn't answering yet.`);
    this.schedule();
  }

  /** Its Friday, asked through the tunnel how it is: what it is, and how many runs it has going. */
  async check(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.host.port}/api/host/status`, { signal: AbortSignal.timeout(4_000), headers: { "x-friday-host-check": "1" } });
      const j = (await r.json()) as { version?: string; name?: string; running?: number };
      if (!r.ok || !j.version) return false;
      this.version = j.version;
      this.name = j.name ?? "";
      this.running = Number(j.running) || 0;
      this.lastSeen = Date.now();
      this.set("up", "");
      return true;
    } catch {
      return false;
    }
  }

  private schedule(): void {
    if (this.ask) clearTimeout(this.ask);
    if (this.stopped) return;
    this.ask = setTimeout(async () => {
      if (!(await this.check()) && this.link === "up") this.set("connecting", `${this.host.ssh} isn't answering.`);
      this.schedule();
    }, 15_000);
    this.ask.unref?.();
  }

  private again(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) void this.open();
    }, this.wait);
    this.retry.unref?.();
    this.wait = Math.min(this.wait * 2, 60_000);
  }

  /** Try again now (Reconnect, or this computer back from sleep). */
  kick(): void {
    this.wait = 2_000;
    if (this.child) return void this.check().then((ok) => !ok && this.child?.kill("SIGTERM"));
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.set("connecting", "");
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ask) clearTimeout(this.ask);
    this.retry = this.ask = null;
    const c = this.child;
    this.child = null;
    c?.kill("SIGTERM");
  }

  private set(link: HostLink, error: string): void {
    if (this.link === link && this.error === error) return;
    this.link = link;
    this.error = error;
    this.onChange();
  }
}

export class Hosts {
  private readonly file: string;
  private records: HostRecord[] = [];
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly jobs = new Map<string, AddJob>();
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void>;
  private readonly run: SshRun;

  constructor(private readonly o: { home: string; log?: (line: string) => void; ssh?: SshRun; env?: Record<string, string> }) {
    this.file = path.join(o.home, "hosts.json");
    this.run = o.ssh ?? runSsh;
    this.loaded = readJson(this.file, (v) => objectShape<Store>(v), () => ({}) as Store).then((s) => {
      this.records = (s.hosts ?? []).filter((h) => ID.test(h.id) && SSH_HOST.test(h.ssh) && Number.isInteger(h.port));
    });
  }

  private log(line: string): void {
    (this.o.log ?? console.log)(line);
  }

  /** Every host's tunnel opened, for as long as this Friday runs. */
  async start(): Promise<void> {
    await this.loaded;
    for (const h of this.records) this.tunnel(h).start();
  }

  stop(): void {
    for (const t of this.tunnels.values()) t.stop();
  }

  /** This computer woke or came back online: every host asked again at once. */
  kick(id?: string): void {
    for (const [k, t] of this.tunnels) if (!id || k === id) t.kick();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed = () => {
    for (const fn of this.listeners) fn();
  };

  private tunnel(h: HostRecord): Tunnel {
    let t = this.tunnels.get(h.id);
    if (!t) {
      t = new Tunnel(h, this.changed, (l) => this.log(l));
      this.tunnels.set(h.id, t);
    }
    return t;
  }

  async list(): Promise<HostView[]> {
    await this.loaded;
    return this.records.map((h) => this.view(h));
  }

  private view(h: HostRecord): HostView {
    const t = this.tunnels.get(h.id);
    return {
      ...h,
      url: `http://127.0.0.1:${h.port}`,
      link: t?.link ?? "connecting",
      ...(t?.error ? { error: t.error } : {}),
      ...(t?.version ? { version: t.version } : {}),
      ...(t?.name ? { name: t.name } : {}),
      ...(t && t.lastSeen ? { running: t.running, lastSeen: t.lastSeen } : {}),
    };
  }

  /** Each host's own key (local-key.ts), read over SSH and kept ten minutes: its Friday answers only what carries it. */
  private readonly keys = new Map<string, { key: string; at: number }>();

  /**
   * The address that opens a host's Friday in a window or a browser here: with a pass made from its key, read from the box over
   * SSH (the person's own login there, the only one that can read it). A host from before the key asks for none: its plain address.
   */
  async enterUrl(id: string): Promise<string | null> {
    await this.loaded;
    const h = this.records.find((x) => x.id === id);
    if (!h) return null;
    const url = `http://127.0.0.1:${h.port}`;
    let kept = this.keys.get(id);
    if (!kept || Date.now() - kept.at > 10 * 60_000) {
      const got = await this.run(["--", h.ssh, `cat "$HOME/.friday-host/data/${KEY_FILE}" 2>/dev/null`], { ms: 6_000 }).catch(() => ({ code: 1, out: "" }));
      const key = got.code === 0 ? (/^[\w-]{32,100}$/m.exec(got.out.trim())?.[0] ?? "") : "";
      kept = { key, at: Date.now() };
      // Not kept when it couldn't be read: asked again next time, since the box may only have been out of reach.
      if (key) this.keys.set(id, kept);
    }
    return kept.key ? enterLink(url, kept.key, 2 * 60_000) : url;
  }

  /** The hosts in this person's ~/.ssh/config, to pick from, less the ones already hosts. */
  async sshHosts(): Promise<string[]> {
    await this.loaded;
    const cfg = process.env.FRIDAY_SSH_CONFIG || path.join(homedir(), ".ssh", "config");
    const all = sshConfigHosts(await readFile(cfg, "utf8").catch(() => ""));
    return all.filter((h) => !this.records.some((r) => r.ssh === h)).slice(0, 100);
  }

  job(id: string): AddJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** The ports a new host is offered on: free here, from one picked by its id, clear of the other hosts'. */
  private async ports(id: string): Promise<number[]> {
    const start = PORT_BASE + (parseInt(createHash("sha256").update(id).digest("hex").slice(0, 6), 16) % PORT_SPAN);
    const out: number[] = [];
    for (let i = 0; i < PORT_SPAN && out.length < 6; i++) {
      const p = PORT_BASE + ((start - PORT_BASE + i) % PORT_SPAN);
      if (this.records.some((r) => r.port === p)) continue;
      if (await freeHere(p)) out.push(p);
    }
    return out;
  }

  /**
   * Adding a host over SSH, as a job Settings › Other computers follows: connected, the same Friday carried there and installed, started as
   * a service on a port free at both ends, and its tunnel up. Updating one is the same with its record: installed again, kept.
   */
  add(ssh: string, label?: string, update?: string): AddJob | { error: string } {
    ssh = ssh.trim();
    if (!SSH_HOST.test(ssh)) return { error: "That isn't a host ssh can take: a name from your ~/.ssh/config, a host name, or user@host." };
    const was = update ? this.records.find((r) => r.id === update) : undefined;
    if (update && !was) return { error: "There's no such host." };
    if (!was && this.records.some((r) => r.ssh === ssh)) return { error: `${ssh} is already a host. Update it from its row instead.` };
    const running = [...this.jobs.values()].find((j) => j.ssh === ssh && !j.done);
    if (running) return running;
    const job: AddJob = {
      id: randomBytes(8).toString("hex"),
      ssh,
      done: false,
      steps: [
        { id: "connect", state: "doing", text: `Connecting to ${ssh} over SSH` },
        { id: "install", state: "waiting", text: "Installing Friday there" },
        { id: "service", state: "waiting", text: "Starting it as a service, so it keeps running after you log out" },
        { id: "open", state: "waiting", text: "Opening it here" },
      ],
    };
    this.jobs.set(job.id, job);
    void this.doAdd(job, label?.trim().slice(0, 40) || (was?.label ?? ssh), was).catch((e: Error) => this.fail(job, e.message));
    return job;
  }

  private step(job: AddJob, id: AddStep["id"], state: AddStep["state"], text?: string): void {
    const s = job.steps.find((x) => x.id === id)!;
    s.state = state;
    if (text) s.text = text;
    this.changed();
  }

  private fail(job: AddJob, error: string): void {
    const s = job.steps.find((x) => x.state === "doing");
    if (s) s.state = "failed";
    job.error = error;
    job.done = true;
    this.changed();
  }

  private async doAdd(job: AddJob, label: string, was?: HostRecord): Promise<void> {
    await this.loaded;
    const ssh = job.ssh;
    // 1. Connected, and where it lives.
    const hello = await this.run(["--", ssh, "uname -srm && printf '%s\\n' \"$HOME\""], { ms: 30_000 });
    if (hello.code !== 0) return this.fail(job, hostResult(hello.out, ssh).ok ? `Couldn't connect to ${ssh}.` : (hostResult(hello.out, ssh) as { error: string }).error);
    if (/^(MINGW|MSYS|CYGWIN|Windows)/im.test(hello.out) || /is not recognized/i.test(hello.out)) return this.fail(job, `${ssh} looks like a Windows machine. Hosts run on macOS and Linux.`);
    const [kernel = "", , arch = ""] = hello.out.split(/\r?\n/)[0]!.trim().split(/\s+/);
    const system = kernel === "Darwin" ? "macOS" : kernel;
    this.step(job, "connect", "done", `Connected to ${ssh} (${[system, arch].filter(Boolean).join(", ")})`);
    // 2. The same Friday as this one, carried there and installed.
    this.step(job, "install", "doing");
    const pkg = await hostPackage();
    if ("file" in pkg) {
      const size = (await stat(pkg.file)).size;
      const sent = await this.run(["--", ssh, `mkdir -p "$HOME/.friday-host" && chmod 700 "$HOME/.friday-host" && cat > "$HOME/.friday-host/friday.tgz"`], { ms: 10 * 60_000, stdin: createReadStream(pkg.file) });
      if (sent.code !== 0) return this.fail(job, `Couldn't copy Friday to ${ssh} (${Math.round(size / 1e6)} MB): ${sent.out.trim().split("\n").pop() ?? "ssh said no"}`);
    }
    const installed = await this.run(["--", ssh, "sh -s"], { ms: 15 * 60_000, stdin: hostScript({ part: "install", pkg: "file" in pkg ? "./friday.tgz" : pkg.spec, label }) });
    const inst = installed.out.match(/^FRIDAY_INSTALLED (\S+)$/m);
    if (!inst) return this.fail(job, (hostResult(installed.out, ssh) as { error: string }).error ?? "Friday couldn't be installed.");
    this.step(job, "install", "done", `Friday ${inst[1]} installed there`);
    // 3. Run as a service on a port free here and there.
    this.step(job, "service", "doing");
    const id = was?.id ?? randomBytes(6).toString("hex");
    if (was) this.tunnels.get(was.id)?.stop();
    const ports = was ? [was.port, ...(await this.ports(id)).filter((p) => p !== was.port)] : await this.ports(id);
    if (!ports.length) return this.fail(job, "No port is free on this computer for it.");
    const env: Record<string, string> = { ...(this.o.env ?? {}) };
    if (process.env.FRIDAY_NO_TELEMETRY === "1") env.FRIDAY_NO_TELEMETRY = "1";
    const ran = await this.run(["--", ssh, "sh -s"], { ms: 6 * 60_000, stdin: hostScript({ part: "service", ports, label, env }) });
    const got = hostResult(ran.out, ssh);
    if (!got.ok) return this.fail(job, got.error);
    this.step(job, "service", "done", got.how === "systemd" ? "Running as a systemd service" : got.how === "launchd" ? "Running as a launchd service" : "Running in the background");
    // 4. Kept here, and its tunnel up.
    this.step(job, "open", "doing");
    const rec: HostRecord = { id, label, ssh, port: got.port, addedAt: was?.addedAt ?? Date.now(), how: got.how, ...(got.os ? { os: got.os } : {}), ...(got.warn ? { warn: got.warn } : {}) };
    await this.save((list) => [...list.filter((r) => r.id !== id), rec]);
    const t = this.tunnels.get(id);
    if (t) {
      this.tunnels.delete(id);
      t.stop();
    }
    const tun = this.tunnel(rec);
    tun.start();
    for (let n = 0; n < 60 && tun.link !== "up"; n++) await new Promise((r) => setTimeout(r, 500));
    if (tun.link !== "up") return this.fail(job, tun.error || `${ssh} is set up, but couldn't be opened here.`);
    this.step(job, "open", "done", "Open here");
    job.host = this.view(rec);
    if (got.warn) job.warn = got.warn;
    job.done = true;
    this.changed();
  }

  private async save(change: (list: HostRecord[]) => HostRecord[]): Promise<void> {
    await updateJson(this.file, { shape: (v) => objectShape<Store>(v), empty: () => ({}) as Store, mode: 0o600 }, (s) => {
      s.hosts = change(s.hosts ?? []);
      this.records = s.hosts;
    });
    this.changed();
  }

  async rename(id: string, label: string): Promise<void> {
    const l = label.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!l) throw new Error("Give it a name.");
    await this.save((list) => list.map((r) => (r.id === id ? { ...r, label: l } : r)));
    const t = this.tunnels.get(id);
    if (t) (t.host as { label: string }).label = l;
  }

  /**
   * Taken off: its service stopped and its program removed there (its data stays, so its sessions are there if it's added again),
   * its tunnel closed here. `forget` alone, when the box can't be reached: it's only dropped here, said so.
   */
  async remove(id: string, o: { forget?: boolean } = {}): Promise<{ ok: true; left?: string } | { ok: false; error: string; unreachable?: boolean }> {
    await this.loaded;
    const h = this.records.find((r) => r.id === id);
    if (!h) return { ok: false, error: "There's no such host." };
    let left: string | undefined;
    if (!o.forget) {
      const ran = await this.run(["--", h.ssh, "sh -s"], { ms: 60_000, stdin: hostScript({ part: "remove" }) });
      if (!/^FRIDAY_REMOVED$/m.test(ran.out)) {
        const why = hostResult(ran.out, h.ssh);
        return { ok: false, unreachable: true, error: `${"error" in why ? why.error : `Couldn't reach ${h.ssh}.`} Remove it from this computer only? Friday would keep running there.` };
      }
      left = `Its sessions and settings stay on ${h.ssh} in ~/.friday-host/data.`;
    } else left = `Friday may still be running on ${h.ssh}. Remove ~/.friday-host there to take it off.`;
    this.tunnels.get(id)?.stop();
    this.tunnels.delete(id);
    await this.save((list) => list.filter((r) => r.id !== id));
    return { ok: true, ...(left ? { left } : {}) };
  }
}
