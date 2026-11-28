import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import type { FileStore } from "../src/files.js";
import { gitCall, inUntrustedRepo } from "../src/runner/git.js";
import { inUploadedGitDir, UploadedFolders } from "../src/uploaded.js";

/**
 * An upload never brings git's own folder, and git in an uploaded folder runs nothing the folder names.
 *
 * Git starts the programs its settings name: a hook, a filter or textconv driver, an external diff. Friday runs git in an
 * uploaded folder as the server, so a `.git` that arrived inside an archive chose what the server ran (2026-11-27 security
 * review). Nothing here runs such a program to see: the tests read the tree that was written and the call git is given.
 */

/** Every path under `dir`, relative, folders included. */
async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    out.push(p);
    if (e.isDirectory()) out.push(...(await walk(dir, p)));
  }
  return out;
}

const noFiles = { get: async () => null } as unknown as FileStore;
/** A setting no git knows, standing in for one that names a program: what is asserted is that it is gone. */
const FOREIGN = "[uploaded]\n\tbyTheArchive = true\n";

async function folders(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-upgit-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return { dir, up: new UploadedFolders(noFiles, dir) };
}

test("git's own folder is recognised however an archive spells it, and nothing else is", () => {
  for (const p of [".git/config", ".git", "app/.git/hooks/pre-commit", ".GIT/config", ".git./config", ".git /config", "a\\.git\\config", "vendor/lib/.Git/HEAD", "GIT~1/config", ".g‌it/config"]) {
    assert.equal(inUploadedGitDir(p), true, p);
  }
  for (const p of [".gitignore", ".gitattributes", ".github/workflows/ci.yml", "src/git/index.ts", "docs/.gitkeep", "my.git/readme", "git~x/a"]) {
    assert.equal(inUploadedGitDir(p), false, p);
  }
});

test("an archive that carries a .git unpacks to a folder with none, at any depth", async (t) => {
  const { dir, up } = await folders(t);
  const zip = new JSZip();
  zip.file("fleet/src/app.ts", "export const PORT = 8080;\n");
  zip.file("fleet/.gitignore", "node_modules\n");
  zip.file("fleet/.gitattributes", "*.ts text\n");
  zip.file("fleet/.github/workflows/ci.yml", "on: push\n");
  zip.file("fleet/.git/config", FOREIGN);
  zip.file("fleet/.git/hooks/pre-commit", "#!/bin/sh\n");
  zip.file("fleet/.GIT/config", FOREIGN);
  zip.file("fleet/vendor/lib/.git/config", FOREIGN);
  zip.file("fleet/vendor/lib/a.ts", "export {};\n");
  zip.file("fleet/docs/.git", "gitdir: ../.git\n");
  const done = await up.unpack("s1", await zip.generateAsync({ type: "nodebuffer" }), "fleet");
  const tree = await walk(up.rootFor("s1"));
  assert.deepEqual(tree.filter((p) => inUploadedGitDir(p)), [], "nothing of git's own was written");
  assert.deepEqual(tree.filter((p) => /config$|pre-commit$/.test(p)), []);
  for (const kept of ["src/app.ts", ".gitignore", ".gitattributes", ".github/workflows/ci.yml", "vendor/lib/a.ts"]) assert.ok(tree.includes(kept), `${kept} is the project's and stays`);
  assert.equal(done.files, 5, "and the count is of what was kept");
  assert.deepEqual((await readdir(dir)).sort(), ["s1", "s1.upload.json"]);
});

test("files attached one by one cannot write a .git either", async (t) => {
  const { dir } = await folders(t);
  const blobs = new Map([["f1", "x\n"], ["f2", FOREIGN], ["f3", "#!/bin/sh\n"]]);
  const store = { get: async (_sid: string, id: string) => (blobs.has(id) ? { data: Buffer.from(blobs.get(id)!) } : null) } as unknown as FileStore;
  const up = new UploadedFolders(store, dir);
  const att = (id: string, name: string) => ({ id, name, type: "text/plain", size: 2 });
  const folder = await up.ensure("s2", [att("f1", "fleet/a.txt"), att("f2", "fleet/.git/config"), att("f3", "fleet/sub/.git/hooks/pre-commit")]);
  assert.equal(folder?.files, 1);
  assert.deepEqual(await walk(up.rootFor("s2")), ["a.txt"]);
});

test("a .git already in an uploaded folder that Friday did not make is replaced by Friday's own before git runs there", async (t) => {
  const { up } = await folders(t);
  const zip = new JSZip();
  zip.file("fleet/a.txt", "a\n");
  zip.file("fleet/b.txt", "b\n");
  await up.unpack("s3", await zip.generateAsync({ type: "nodebuffer" }), "fleet");
  const root = up.rootFor("s3");
  // As a folder uploaded before this was closed would be: the archive's own repository, sitting where Friday's goes.
  await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(root, ".git", "config"), FOREIGN);
  await writeFile(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");

  // A question that is not git's (the tree) already clears it: a search there is `git grep`.
  await up.read("s3", [], { op: "tree" });
  assert.equal(existsSync(path.join(root, ".git")), false, "the uploaded repository is gone before anything reads it");

  await writeFile(path.join(root, ".git"), "gitdir: /somewhere/else\n");
  await up.read("s3", [], { op: "branches" });
  const config = await readFile(path.join(root, ".git", "config"), "utf8");
  assert.doesNotMatch(config, /byTheArchive/, "the repository is one Friday made");
  assert.deepEqual((await readdir(path.join(root, ".git", "hooks")).catch(() => [])), [], "with no hooks, a server's template included");
  assert.ok(existsSync(`${root}.repo.json`), "and marked as Friday's beside the folder, where no upload can write");

  // Friday's own is kept from then on: undo depends on it.
  await writeFile(path.join(root, ".git", "friday-kept"), "1");
  await up.read("s3", [], { op: "branches" });
  await up.read("s3", [], { op: "tree" });
  assert.ok(existsSync(path.join(root, ".git", "friday-kept")));
});

test("git in an uploaded folder is given no hooks, no outside settings, no diff programs and none of the server's environment", async (t) => {
  process.env.SESSION_SECRET_FOR_TEST = "should-never-reach-git";
  t.after(() => delete process.env.SESSION_SECRET_FOR_TEST);

  const status = gitCall(["-c", "core.quotePath=false", "status", "--porcelain"], undefined, true);
  const pairs = status.args.flatMap((a, i) => (a === "-c" ? [status.args[i + 1]!] : []));
  // No hooks: an empty folder of Friday's own, not the null device, which git on Windows can't open (CI, 2026-11-28).
  const hooks = pairs.find((p) => p.startsWith("core.hooksPath="))!.slice("core.hooksPath=".length);
  assert.ok(existsSync(hooks) && readdirSync(hooks).length === 0, "hooks: an empty folder");
  assert.ok(pairs.includes("core.fsmonitor=false"));
  assert.deepEqual(status.args.slice(-2), ["status", "--porcelain"]);
  assert.equal(status.env?.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(status.env?.GIT_CONFIG_GLOBAL && readFileSync(status.env.GIT_CONFIG_GLOBAL, "utf8") === "", "global settings: an empty file");
  assert.equal(status.env?.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(status.env?.GIT_TERMINAL_PROMPT, "0");
  assert.ok(status.env?.PATH, "git still has a PATH to find itself on");
  assert.equal(status.env?.SESSION_SECRET_FOR_TEST, undefined, "built up, not filtered down");
  assert.equal(status.env?.HOME, undefined, "and no home folder to read a per-user config from");

  // Every command that draws a diff refuses the programs a repository can name for drawing one.
  for (const sub of ["diff", "show", "log", "diff-tree", "diff-index", "diff-files"]) {
    const c = gitCall(["-c", "core.longpaths=true", "--git-dir", "/x", "--work-tree", "/y", sub, "HEAD"], undefined, true);
    const at = c.args.indexOf(sub);
    assert.deepEqual(c.args.slice(at, at + 4), [sub, "--no-ext-diff", "--no-textconv", "HEAD"], sub);
  }
  // What a call passes for itself (a throwaway index, who commits) still arrives, and cannot undo the above.
  const own = gitCall(["add", "-A"], { GIT_INDEX_FILE: "/tmp/i", GIT_CONFIG_GLOBAL: "/etc/passwd" }, true);
  assert.equal(own.env?.GIT_INDEX_FILE, "/tmp/i");
  assert.ok(own.env?.GIT_CONFIG_GLOBAL && readFileSync(own.env.GIT_CONFIG_GLOBAL, "utf8") === "");

  // Decided by where the call is made from, with nobody having to pass it down.
  assert.equal((await inUntrustedRepo(async () => gitCall(["status"]))).env?.GIT_CONFIG_NOSYSTEM, "1");
  await inUntrustedRepo(async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.ok(gitCall(["status"]).args.includes(`core.hooksPath=${hooks}`), "across an await too");
  });
  // On a person's own computer git is theirs: their settings, their hooks, their environment.
  const mine = gitCall(["status"]);
  assert.deepEqual(mine.args, ["status"]);
  assert.equal(mine.env, undefined);
});
