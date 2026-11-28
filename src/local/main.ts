/**
 * Friday on your own computer (the open-source edition), from a terminal.
 *
 * Your coding agents (Claude Code, Codex, Cursor and the rest you have installed) side by side, in one place, on this computer.
 * Nothing hosted and no account: the server is this process, answering only this computer's own browser; what it keeps is in
 * one folder (FRIDAY_HOME, else ~/.friday); and the work runs on your tools' own plans. Friday's own models aren't part of it.
 * The desktop app (desktop.ts) starts the same thing in a window of its own.
 *
 *   npx github:splashxmoon/friday-code   start it and open it in your browser
 *   PORT=4321 FRIDAY_HOME=…         where it listens, and where it keeps things
 *   --no-open                       don't open the browser
 *   --join '<friday://computer?…>'  be another computer's extra machine: pair with it once (its Settings › Your computers ›
 *                                   Add a computer), and keep its link; nothing opens
 *   … mcp                           Friday's MCP server on stdin and stdout, for an agent outside Friday (Claude Code, Codex,
 *                                   Cursor) to hand it work: `claude mcp add friday -- npx -y github:splashxmoon/friday-code mcp`
 */
import { spawn } from "node:child_process";

// Not a Friday to start: the server an outside agent runs, which only talks to the Friday already running (outside-mcp.ts).
if (process.argv[2] === "mcp") {
  await (await import("./outside-mcp.js")).serveOutsideMcp();
  await new Promise(() => {});
}
// Its errors and warnings kept in <FRIDAY_HOME>/diagnostics/friday.log, and a stray error logged rather than ending every session
// (diagnostics.ts), as in the desktop app: Settings › Updates › Copy diagnostics reads it.
(await import("../diagnostics.js")).installProcessLog();
const { startLocal, FridayAlreadyOpen } = await import("./start.js");
// Another computer's extra machine (add-computer.ts): paired with the link, run headless; as a service, removed there it stops for
// good (exit 0, which launchd and systemd don't start again), rather than trying again forever.
const at = process.argv.indexOf("--join");
const join = at > 0 ? process.argv[at + 1] : process.env.FRIDAY_JOIN;
const friday = await startLocal({
  ...(join ? { join } : {}),
  ...(process.env.FRIDAY_SERVICE === "1" ? { onGone: () => (console.log("[computers] removed there: stopping"), void friday.close().finally(() => process.exit(0))) } : {}),
}).catch((e: unknown) => {
  // Another Friday has this folder and isn't answering yet: said plainly, and not started beside it (start.ts takeLock).
  if (e instanceof FridayAlreadyOpen) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
console.log(friday.already ? `Friday is already running at ${friday.url}` : `Friday is running at ${friday.url}`);
if (!friday.already) console.log(`Kept in ${friday.home}. Stop with Ctrl+C.`);
// Friday answers only what carries this install's key (local-key.ts), so a browser is let in by a link that works once, for a
// few minutes: opened below, and said here for a browser this computer can't open (another one's, through a tunnel). Only to
// a terminal: a service's output is kept in a log, where a link has no business.
const { enterLink } = await import("./local-key.js");
const opens = !join && !process.argv.includes("--no-open") && process.env.FRIDAY_NO_OPEN !== "1";
if (friday.key && !join && !opens && process.stdout.isTTY) console.log(`Open it with this link (it works once, for ten minutes; run this again for another):\n  ${enterLink(friday.url, friday.key, 10 * 60_000)}`);

if (opens) {
  const to = friday.key ? enterLink(friday.url, friday.key, 2 * 60_000) : friday.url;
  const open = process.platform === "darwin" ? ["open", [to]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", to]] : ["xdg-open", [to]];
  try {
    spawn(open[0] as string, open[1] as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser to open: the address above is enough.
  }
}
if (friday.already) process.exit(0);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await friday.close();
    process.exit(0);
  });
}
