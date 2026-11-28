import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addWorktree, applyCopy, baseAfterCommit, checkpoint, commitAll, diffTrees, dropWorktree, restore, sessionBase } from "../src/runner/git.js";

/**
 * A folder somebody is working in. What the agent changed is measured from where the folder stood when it arrived, their
 * unfinished edits included, so those are never listed (or shipped) as the agent's; an undo puts back only what the run
 * changed; and an agent in a separate copy brings its work back with Apply, leaving theirs alone.
 */

async function repo(): Promise<{ dir: string; g: (...a: string[]) => string; done: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-busy-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "core.autocrlf", "false");
  await writeFile(path.join(dir, "mine.txt"), "one\n");
  await writeFile(path.join(dir, "app.txt"), "a\nb\nc\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { dir, g, done: () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

test("the agent's changes are measured from where the folder stood, so the person's own edits aren't listed as its", async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  // The person's unfinished work, before the session.
  await writeFile(path.join(dir, "mine.txt"), "one, still being written\n");
  await writeFile(path.join(dir, "notes.txt"), "an untracked draft\n");

  const base = (await sessionBase(dir, "s1/abc"))!;
  assert.match(base, /^[0-9a-f]{40}$/);
  assert.equal(await sessionBase(dir, "s1/abc"), base, "a reconnect finds the same starting point");

  await writeFile(path.join(dir, "app.txt"), "a\nB\nc\n");
  await writeFile(path.join(dir, "new.txt"), "made by the agent\n");
  assert.deepEqual(paths(await diffTrees(dir, base)), ["app.txt", "new.txt"], "only what the agent did");

  // Shipping those two: the commit has them alone, and what's left to show is nothing, the person's work still theirs.
  const c = await commitAll(dir, "agent work", undefined, ["app.txt", "new.txt"]);
  assert.equal(c.files, 2);
  const next = await baseAfterCommit(dir, base, `${c.sha}^`, c.sha);
  assert.deepEqual(await diffTrees(dir, next), []);
  assert.equal(await readFile(path.join(dir, "mine.txt"), "utf8"), "one, still being written\n");
  assert.match(g("status", "--porcelain"), /M mine\.txt/, "still uncommitted");
});

test("undo with the run's end puts back only what the run changed", async (t) => {
  const { dir, done } = await repo();
  t.after(done);
  const start = (await checkpoint(dir, "run"))!;
  await writeFile(path.join(dir, "app.txt"), "a\nby the agent\nc\n");
  await writeFile(path.join(dir, "made.txt"), "agent file\n");
  const end = (await checkpoint(dir, "run end"))!;
  // The person, after the run, in a file the run never touched.
  await writeFile(path.join(dir, "mine.txt"), "one, edited after the run\n");

  const r = await restore(dir, start, end);
  assert.equal(r.restored, 1);
  assert.equal(r.removed, 1);
  assert.equal(await readFile(path.join(dir, "app.txt"), "utf8"), "a\nb\nc\n");
  assert.equal(await readFile(path.join(dir, "mine.txt"), "utf8"), "one, edited after the run\n", "the person's later edit stays");
});

test("an agent in a separate copy brings its work back with Apply, and the person's work there is kept", async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  await writeFile(path.join(dir, "mine.txt"), "one, being written\n");
  const copy = await addWorktree(dir, "claude", true);
  t.after(() => dropWorktree(copy.path).then(() => {}));
  assert.equal(await readFile(path.join(copy.path, "mine.txt"), "utf8"), "one, being written\n", "their changes came along");
  const base = (await sessionBase(copy.path, "s2/copy"))!;

  await writeFile(path.join(copy.path, "app.txt"), "a\nb\nc\nd\n");
  await writeFile(path.join(copy.path, "added.txt"), "new\n");
  // Meanwhile, in their own folder.
  await writeFile(path.join(dir, "mine.txt"), "one, being written, and more\n");
  assert.equal(await readFile(path.join(dir, "app.txt"), "utf8"), "a\nb\nc\n", "untouched until Apply");

  const r = await applyCopy(copy.path, base, dir);
  assert.deepEqual(r.files.sort(), ["added.txt", "app.txt"]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(await readFile(path.join(dir, "app.txt"), "utf8"), "a\nb\nc\nd\n");
  assert.equal(await readFile(path.join(dir, "added.txt"), "utf8"), "new\n");
  assert.equal(await readFile(path.join(dir, "mine.txt"), "utf8"), "one, being written, and more\n", "theirs is kept");
  assert.equal(g("diff", "--cached", "--name-only"), "", "nothing staged");
});

test("Apply where both changed the same lines leaves conflict markers and says which files", async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  const copy = await addWorktree(dir, "codex", true);
  t.after(() => dropWorktree(copy.path).then(() => {}));
  const base = (await sessionBase(copy.path, "s3/copy"))!;
  await writeFile(path.join(copy.path, "app.txt"), "a\nagent\nc\n");
  await writeFile(path.join(dir, "app.txt"), "a\nperson\nc\n");

  const r = await applyCopy(copy.path, base, dir);
  assert.deepEqual(r.conflicts, ["app.txt"]);
  assert.match(await readFile(path.join(dir, "app.txt"), "utf8"), /<<<<<<<[\s\S]*person[\s\S]*agent|<<<<<<<[\s\S]*agent[\s\S]*person/);
  assert.equal(g("diff", "--cached", "--name-only"), "", "nothing staged, conflict included");
});

test("an Apply that fails part way puts back everything it already wrote: no conflict markers left behind (Arun, 2026-11-28)", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const { dir, g, done } = await repo();
  t.after(async () => (await chmod(path.join(dir, "zz"), 0o755).catch(() => {}), await done()));
  const copy = await addWorktree(dir, "codex", true);
  t.after(() => dropWorktree(copy.path).then(() => {}));
  const base = (await sessionBase(copy.path, "s4/copy"))!;
  // Both change app.txt (a merge with markers, written first), then a file in a folder that can't be written to (it throws).
  await writeFile(path.join(copy.path, "app.txt"), "a\nagent\nc\n");
  await mkdir(path.join(copy.path, "zz"), { recursive: true });
  await writeFile(path.join(copy.path, "zz", "new.txt"), "new\n");
  await writeFile(path.join(dir, "app.txt"), "a\nperson\nc\n");
  await mkdir(path.join(dir, "zz"), { recursive: true });
  await chmod(path.join(dir, "zz"), 0o555);
  await assert.rejects(applyCopy(copy.path, base, dir));
  assert.equal(await readFile(path.join(dir, "app.txt"), "utf8"), "a\nperson\nc\n", "the person's file is as it was, no markers");
  assert.equal(g("diff", "--cached", "--name-only"), "", "nothing staged");
});

test("on a Windows-style checkout (autocrlf on) the files a commit recorded stop showing as changed", async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  g("config", "core.autocrlf", "true");
  // As git checks files out with autocrlf on: CRLF on disk, LF in the commit.
  await writeFile(path.join(dir, "win.txt"), "one\r\ntwo\r\n");
  g("add", "-A");
  g("commit", "-qm", "a crlf file");
  const base = (await sessionBase(dir, "s2/win"))!;
  assert.deepEqual(await diffTrees(dir, base), [], "nothing changed yet");
  await writeFile(path.join(dir, "win.txt"), "one\r\ntwo\r\nthree\r\n");
  assert.deepEqual(paths(await diffTrees(dir, base)), ["win.txt"]);

  const c = await commitAll(dir, "a third line", undefined, ["win.txt"]);
  const next = await baseAfterCommit(dir, base, `${c.sha}^`, c.sha);
  assert.deepEqual(await diffTrees(dir, next), [], "committed is committed, whatever the line endings");
  assert.deepEqual(await diffTrees(dir, "HEAD"), [], "and measured against HEAD, the same");
});

test("Apply brings folders over as git sees them: a new folder made, a deleted one gone, a file turned folder and a folder turned file, never a folder read as a file", async (t) => {
  const { dir, g, done } = await repo();
  t.after(done);
  await mkdir(path.join(dir, "olddir", "sub"), { recursive: true });
  await writeFile(path.join(dir, "olddir", "x.txt"), "x\n");
  await writeFile(path.join(dir, "olddir", "sub", "y.txt"), "y\n");
  await writeFile(path.join(dir, "thing"), "a file for now\n");
  await mkdir(path.join(dir, "folder2"));
  await writeFile(path.join(dir, "folder2", "z.txt"), "z\n");
  g("add", "-A");
  g("commit", "-qm", "folders");
  const copy = await addWorktree(dir, "coder", true);
  t.after(() => dropWorktree(copy.path).then(() => {}));
  const base = (await sessionBase(copy.path, "s9/copy"))!;
  const c = (...p: string[]) => path.join(copy.path, ...p);
  await mkdir(c("newdir", "deep"), { recursive: true });
  await writeFile(c("newdir", "deep", "a.txt"), "new\n");
  await rm(c("olddir"), { recursive: true });
  await rm(c("thing"));
  await mkdir(c("thing"));
  await writeFile(c("thing", "inner.txt"), "now a folder\n");
  await rm(c("folder2"), { recursive: true });
  await writeFile(c("folder2"), "now a file\n");
  // Both changed the same lines of one file: the one-patch way can't apply, so each path is brought over on its own.
  await writeFile(c("app.txt"), "a\nagent\nc\n");
  await writeFile(path.join(dir, "app.txt"), "a\nperson\nc\n");

  const r = await applyCopy(copy.path, base, dir);
  assert.deepEqual(r.conflicts, ["app.txt"]);
  assert.equal(await readFile(path.join(dir, "newdir", "deep", "a.txt"), "utf8"), "new\n");
  await assert.rejects(stat(path.join(dir, "olddir")), "the deleted folder is gone, empty folders too");
  assert.equal(await readFile(path.join(dir, "thing", "inner.txt"), "utf8"), "now a folder\n");
  assert.equal(await readFile(path.join(dir, "folder2"), "utf8"), "now a file\n");
  assert.equal(await readFile(path.join(dir, "mine.txt"), "utf8"), "one\n");
});
