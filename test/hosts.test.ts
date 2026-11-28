// Hosts: your Fridays on other machines, run there as a service and opened here over SSH (src/local/hosts.ts, spec 15; Arun,
// 2026-11-26: "we need proper infrastructure and setup for this to work… be very thorough").
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hostResult, Hosts, hostScript, tunnelError, type AddJob } from "../src/local/hosts.js";

// The published package by name, in this repository and in the public one alike: a clone of the public repo would otherwise pack
// itself and copy it over first, a step these stand-in boxes don't answer (hostPackage).
process.env.FRIDAY_HOST_PACKAGE = "public";

const sound = (script: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fb-host-"));
  writeFileSync(path.join(dir, "s.sh"), script);
  execFileSync("sh", ["-n", path.join(dir, "s.sh")]);
};

test("the install script is sound shell, installs the package it's given into ~/.friday-host, and stops an old service first", () => {
  const s = hostScript({ part: "install", pkg: "./friday.tgz", label: "Hetzner" });
  sound(s);
  assert.match(s, /DIR="\$HOME\/\.friday-host"/);
  assert.match(s, /PKG="\.\/friday\.tgz"/);
  assert.match(s, /case "\$PKG" in \.\/\*\) PKG="\$DIR\/\$\{PKG#\.\/\}"/, "a package sent there is read from beside it");
  assert.match(s, /"\$NPM" install --prefix "\$DIR"/);
  assert.match(s, /"\$MAJOR" -ge 22/);
  assert.ok(s.indexOf("systemctl --user disable --now friday-host.service") < s.indexOf('"$NPM" install'), "the old service stopped before installing over it");
  assert.match(s, /FRIDAY_INSTALLED/);
  // No package here: the public one, by name; anything that isn't a plain path or name is refused for the public one.
  assert.match(hostScript({ part: "install" }), /PKG="github:splashxmoon\/friday-code"/);
  assert.match(hostScript({ part: "install", pkg: "x'; rm -rf ~; '" }), /PKG="github:splashxmoon\/friday-code"/);
});

test("the service script is sound shell: a port free there from the ones offered, Friday headless on it as a service, waited for", () => {
  const s = hostScript({ part: "service", ports: [4600, 4601, 99999, 80], label: "Mac mini", env: { FRIDAY_NO_TELEMETRY: "1", "BAD KEY": "x", FRIDAY_X: "a b; rm" } });
  sound(s);
  assert.match(s, /' 4600 4601\)/, "only real, unprivileged ports are offered");
  assert.match(s, /"FRIDAY_HOME=\$DIR\/data" "PORT=\$PORT" "FRIDAY_SERVICE=1" "FRIDAY_NO_OPEN=1" "FRIDAY_HOST=1" "FRIDAY_NO_TELEMETRY=1"/);
  assert.doesNotMatch(s, /BAD KEY|a b; rm/, "an environment value that could break out of the script is left out");
  assert.match(s, /--no-open/);
  assert.match(s, /friday-host\.service/);
  assert.match(s, /loginctl enable-linger/);
  assert.match(s, /com\.tryfriday\.host/);
  assert.match(s, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(s, /\/api\/host\/status/, "up once its own address answers as Friday");
  assert.match(s, /FRIDAY_UP \$UP/);
  assert.match(s, /Description=Friday, as a host for %s/);
});

test("the remove script stops the service everywhere it may run and takes the program off, keeping the data", () => {
  const s = hostScript({ part: "remove" });
  sound(s);
  assert.match(s, /systemctl --user disable --now friday-host\.service/);
  assert.match(s, /launchctl bootout "gui\/\$\(id -u\)\/com\.tryfriday\.host"/);
  assert.match(s, /kill "\$PID"/);
  assert.match(s, /rm -rf "\$DIR\/node_modules"/);
  assert.doesNotMatch(s, /rm -rf "\$DIR"\s|rm -rf "\$DIR\/data"/, "its sessions and settings stay");
  assert.match(s, /FRIDAY_REMOVED/);
});

test("what setup said, in words: up on a port with how it runs, a warning for no linger or the background, or why it failed", () => {
  const ok = hostResult("FRIDAY_OS Linux 6.8.0 x86_64\nFRIDAY_STEP service\nFRIDAY_UP 4612 0.4.4\nFRIDAY_DONE systemd\n", "hetzner");
  assert.deepEqual(ok, { ok: true, port: 4612, version: "0.4.4", how: "systemd", os: "Linux 6.8.0 x86_64" });
  const linger = hostResult("FRIDAY_WARN linger\nFRIDAY_UP 4612 0.4.4\nFRIDAY_DONE systemd\n", "box");
  assert.ok(linger.ok && /loginctl enable-linger/.test(linger.warn ?? ""));
  const bg = hostResult("FRIDAY_UP 4612 0.4.4\nFRIDAY_DONE background\n", "box");
  assert.ok(bg.ok && /won't come back by itself/.test(bg.warn ?? ""));
  const cases: [string, RegExp][] = [
    ["FRIDAY_ERROR old-node 18", /Node 18\. Friday needs Node 22/],
    ["FRIDAY_ERROR no-node", /doesn't have Node/],
    ["FRIDAY_ERROR no-git", /doesn't have git/],
    ["npm ERR! 404\nFRIDAY_ERROR install", /couldn't be installed on box: npm ERR! 404/],
    ["FRIDAY_ERROR no-port", /None of the ports/],
    ["listen EADDRINUSE\nFRIDAY_ERROR not-up", /didn't start within four minutes\. Its log: listen EADDRINUSE/],
    ["Permission denied (publickey).", /didn't accept your key/],
    ["ssh: Could not resolve hostname box", /Couldn't find box/],
    ["Host key verification failed.", /key couldn't be checked/],
    ["ssh: connect to host box port 22: Connection refused", /Couldn't reach box/],
  ];
  for (const [out, want] of cases) {
    const r = hostResult(out, "box");
    assert.equal(r.ok, false, out);
    assert.match((r as { error: string }).error, want, out);
  }
});

test("why a tunnel closed, in words", () => {
  assert.match(tunnelError("bind [127.0.0.1]:4612: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 4612", "box", 4612), /Port 4612 is taken on this computer/);
  assert.match(tunnelError("Permission denied (publickey).", "box", 1), /didn't accept your key/);
  assert.match(tunnelError("ssh: connect to host box port 22: Operation timed out", "box", 1), /Can't reach box right now/);
  assert.match(tunnelError("", "box", 1), /The connection to box closed\./);
});

/**
 * The whole job with ssh stood in: each step said as it goes, the host kept with the port its service came up on, its "tunnel" up
 * (a server here answering /api/host/status as its Friday would), then updated and removed. The stand-in records what was run.
 */
test("adding a host: connected, installed, started, opened, each step said; updated in place; removed, its data left there", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "fb-hosts-"));
  // Its Friday, as the tunnel would bring it here: on the port setup said.
  let running = 2;
  const box = http.createServer((req, res) => {
    if (req.url === "/api/host/status" && req.headers.origin === undefined) return void res.end(JSON.stringify({ version: "0.4.4", name: "hetzner", host: true, running }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
  const port = (box.address() as { port: number }).port;
  t.after(() => box.close());
  const ran: { args: string; stdin: string }[] = [];
  const ssh = async (args: string[], o: { stdin?: string | NodeJS.ReadableStream }) => {
    const stdin = typeof o.stdin === "string" ? o.stdin : "";
    ran.push({ args: args.join(" "), stdin });
    if (args.at(-1)?.startsWith("uname")) return { code: 0, out: "Linux 6.8.0 x86_64\n/home/ada\n" };
    if (/FRIDAY_INSTALLED \$/.test(stdin)) return { code: 0, out: "FRIDAY_OS Linux 6.8.0 x86_64\nFRIDAY_STEP install\nFRIDAY_INSTALLED 0.4.4\n" };
    if (/FRIDAY_STEP service/.test(stdin)) return { code: 0, out: `FRIDAY_OS Linux 6.8.0 x86_64\nFRIDAY_UP ${port} 0.4.4\nFRIDAY_DONE systemd\n` };
    if (/FRIDAY_REMOVED/.test(stdin)) return { code: 0, out: "FRIDAY_REMOVED\n" };
    return { code: 1, out: "?" };
  };
  // The port its service came up on answers already (this test's stand-in), so the tunnel takes it as that host's, as a tunnel
  // from an earlier run still holding it is; no real ssh is started.
  const hosts = new Hosts({ home, ssh, log: () => {} });
  t.after(() => hosts.stop());
  assert.deepEqual(hosts.add("-oProxyCommand=x"), { error: "That isn't a host ssh can take: a name from your ~/.ssh/config, a host name, or user@host." });
  const job = hosts.add("ada@hetzner", "Hetzner") as AddJob;
  assert.equal(job.steps[0]!.state, "doing");
  for (let i = 0; i < 100 && !hosts.job(job.id)!.done; i++) await new Promise((r) => setTimeout(r, 100));
  const done = hosts.job(job.id)!;
  assert.equal(done.error, undefined, done.error);
  assert.deepEqual(done.steps.map((s) => s.state), ["done", "done", "done", "done"]);
  assert.equal(done.steps[0]!.text, "Connected to ada@hetzner (Linux, x86_64)");
  assert.equal(done.steps[1]!.text, "Friday 0.4.4 installed there");
  assert.equal(done.steps[2]!.text, "Running as a systemd service");
  assert.equal(done.host?.label, "Hetzner");
  assert.equal(done.host?.port, port);
  assert.equal(done.host?.link, "up");
  assert.equal(done.host?.running, 2);
  // Without a package of this edition to carry (a test, a hosted build), the public one by name; nothing copied.
  assert.ok(!ran.some((r) => /cat > "\$HOME\/\.friday-host\/friday\.tgz"/.test(r.args)));
  assert.ok(ran.some((r) => /PKG="github:splashxmoon\/friday-code"/.test(r.stdin)));
  // Kept on disk, owner-only.
  const kept = JSON.parse(await readFile(path.join(home, "hosts.json"), "utf8")) as { hosts: { ssh: string; port: number; how: string }[] };
  assert.equal(kept.hosts[0]!.ssh, "ada@hetzner");
  assert.equal(kept.hosts[0]!.how, "systemd");
  // The same machine again is refused; Update installs over it and keeps it.
  assert.match((hosts.add("ada@hetzner") as { error: string }).error, /already a host/);
  const id = (await hosts.list())[0]!.id;
  const again = hosts.add("ada@hetzner", "Hetzner", id) as AddJob;
  for (let i = 0; i < 100 && !hosts.job(again.id)!.done; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(hosts.job(again.id)!.error, undefined);
  assert.equal((await hosts.list()).length, 1);
  assert.equal((await hosts.list())[0]!.id, id, "the same host, kept");
  // Its own port offered first when it's updated.
  assert.match(ran.filter((r) => /FRIDAY_STEP service/.test(r.stdin)).at(-1)!.stdin, new RegExp(`' ${port}( |\\))`));
  // Renamed; then removed: the remove script run there, and gone here.
  await hosts.rename(id, "  Hetzner  box ");
  assert.equal((await hosts.list())[0]!.label, "Hetzner box");
  await assert.rejects(hosts.rename(id, "   "), /Give it a name/);
  const gone = await hosts.remove(id);
  assert.deepEqual(gone, { ok: true, left: "Its sessions and settings stay on ada@hetzner in ~/.friday-host/data." });
  assert.ok(ran.some((r) => /FRIDAY_REMOVED/.test(r.stdin)));
  assert.deepEqual(await hosts.list(), []);
});

test("a host that can't be reached isn't removed until the person says to drop it here only", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "fb-hosts-"));
  writeFileSync(path.join(home, "hosts.json"), JSON.stringify({ hosts: [{ id: "abcdef012345", label: "Gone", ssh: "gone", port: 4999, addedAt: 1 }] }));
  const hosts = new Hosts({ home, log: () => {}, ssh: async () => ({ code: 255, out: "ssh: connect to host gone port 22: Operation timed out" }) });
  t.after(() => hosts.stop());
  const tried = await hosts.remove("abcdef012345");
  assert.equal(tried.ok, false);
  assert.ok(!tried.ok && tried.unreachable && /Couldn't reach gone/.test(tried.error) && /Remove it from this computer only/.test(tried.error));
  assert.equal((await hosts.list()).length, 1, "still here");
  const dropped = await hosts.remove("abcdef012345", { forget: true });
  assert.ok(dropped.ok && /may still be running on gone/.test(dropped.left ?? ""));
  assert.deepEqual(await hosts.list(), []);
});

test("a failed step stops the job there and says why; nothing is kept", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "fb-hosts-"));
  const hosts = new Hosts({
    home,
    log: () => {},
    ssh: async (args, o) => (args.at(-1)?.startsWith("uname") ? { code: 0, out: "Linux 6.8.0\n/home/x\n" } : typeof o.stdin === "string" && /FRIDAY_INSTALLED \$/.test(o.stdin) ? { code: 21, out: "FRIDAY_ERROR old-node 18\n" } : { code: 1, out: "" }),
  });
  t.after(() => hosts.stop());
  const job = hosts.add("box") as AddJob;
  for (let i = 0; i < 100 && !hosts.job(job.id)!.done; i++) await new Promise((r) => setTimeout(r, 50));
  const j = hosts.job(job.id)!;
  assert.deepEqual(j.steps.map((s) => s.state), ["done", "failed", "waiting", "waiting"]);
  assert.match(j.error ?? "", /box has Node 18/);
  assert.deepEqual(await hosts.list(), []);
  // A Windows machine is said to be one, before anything is sent there.
  const win = new Hosts({ home: mkdtempSync(path.join(tmpdir(), "fb-hosts-")), log: () => {}, ssh: async () => ({ code: 0, out: "MINGW64_NT-10.0 3.4.10 x86_64\n/c/Users/x\n" }) });
  const wj = win.add("pc") as AddJob;
  for (let i = 0; i < 100 && !win.job(wj.id)!.done; i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(win.job(wj.id)!.error ?? "", /looks like a Windows machine/);
});

test("a host is opened with a pass made from its own key, read over SSH; one from before the key at its plain address", async () => {
  // A host's Friday answers only what carries its key (src/local/local-key.ts): this computer reads it from the box with the
  // person's own SSH login, and opens the host by a link good once, never with the key itself in an address.
  const { Tickets } = await import("../src/local/local-key.js");
  const home = mkdtempSync(path.join(tmpdir(), "fb-hosts-"));
  writeFileSync(path.join(home, "hosts.json"), JSON.stringify({ hosts: [{ id: "abcdef012345", label: "Box", ssh: "box", port: 4999, addedAt: 1 }] }));
  const key = "K".repeat(43);
  let has = true;
  const asked: string[] = [];
  const hosts = new Hosts({ home, log: () => {}, ssh: async (args) => (asked.push(args.join(" ")), has ? { code: 0, out: `${key}\n` } : { code: 1, out: "" }) });
  const url = (await hosts.enterUrl("abcdef012345"))!;
  assert.match(url, /^http:\/\/127\.0\.0\.1:4999\/#k=/);
  assert.ok(!url.includes(key), "the key itself is in no address");
  assert.ok(new Tickets(key).take(url.split("#k=")[1]), "the pass is one the host's Friday takes");
  assert.match(asked[0]!, /^-- box cat "\$HOME\/\.friday-host\/data\/local-key"/);
  await hosts.enterUrl("abcdef012345");
  assert.equal(asked.length, 1, "read once, then kept a while");
  assert.ok(!JSON.stringify(await hosts.list()).includes(key), "and never in what the page is told about hosts");
  assert.equal(await hosts.enterUrl("000000000000"), null);

  const old = mkdtempSync(path.join(tmpdir(), "fb-hosts-"));
  writeFileSync(path.join(old, "hosts.json"), JSON.stringify({ hosts: [{ id: "abcdef012345", label: "Old", ssh: "old", port: 4998, addedAt: 1 }] }));
  has = false;
  const before = new Hosts({ home: old, log: () => {}, ssh: async () => ({ code: 1, out: "" }) });
  assert.equal(await before.enterUrl("abcdef012345"), "http://127.0.0.1:4998");
});
