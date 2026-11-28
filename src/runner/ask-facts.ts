import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { SECRET_NAME } from "../command-allow.js";
import { lexLine } from "../command-shape.js";

/**
 * What only this computer can say about a command put to a person, sent with the ask (engine.approval `scripts`, `secretRead`).
 *
 * "Always allow" approves a name ("npm test", "cat"), and the allow list is matched on the server from the command's text alone
 * (command-allow.ts). Two things the text does not say (Security M2):
 *
 * - What the name runs. `npm test`, `make`, `pytest`, `git commit` run what the project's own files say (package.json's scripts,
 *   a Makefile, conftest.py, a config written in JavaScript, Git's hooks and settings), and an agent that may edit files can
 *   rewrite those. So the ask carries a fingerprint of them, and a yes given in advance holds only for a state of them the
 *   computer's owner has said yes to: changed since, the command is asked about again, once.
 * - What a path reaches. A file in the folder that is a link to one outside, and a search through every file under a folder
 *   (`grep -r`, `rg --hidden`), read the keys the allow list refuses by name. Said here, such a command is never answered in advance.
 *
 * Read from the disk as it is when the command is asked about, not from the session's record of changes, which trails the edit.
 */

/** Files that say what a project's commands run. Tests and sources are not among them: running those is what a test run is for. */
const DEFINES =
  /^(package\.json|makefile|gnumakefile|justfile|taskfile\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py|noxfile\.py|cargo\.toml|build\.rs|build\.gradle(\.kts)?|pom\.xml|rakefile|gemfile|turbo\.json|nx\.json|deno\.jsonc?|bunfig\.toml|lefthook\.ya?ml|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.eslintrc(\.[\w]+)?|\.babelrc(\.[\w]+)?|\.mocharc(\.[\w]+)?|[\w.-]+\.config\.[cm]?[jt]sx?)$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache", "coverage", "vendor"]);
/** Tools that only read: nothing of the project's is run by them. */
const READS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "sort", "uniq", "fd", "find", "jq", "cd", "echo", "pwd", "which", "true"]);
/** Programs whose first operand is the script they run. */
const INTERPRETERS = /^(sh|bash|zsh|node|tsx|ts-node|deno|bun|python[\d.]*|ruby|perl|php)$/;
const MAX_FILE = 1_000_000;
/** The fingerprint being taken, files named from the project's folder so a copy of the project with the same files has the same one. */
type Print = { hash: import("node:crypto").Hash; name: (p: string) => string };

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** The project's files that define what its commands run, to three folders deep (a workspace's packages), each with its content. */
function definingFiles(cwd: string, into: Print): void {
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of names) {
      if (++seen > 5000) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Husky's hooks run on a commit as Git's own do.
        if (e.name === ".husky") addDir(p, into);
        else if (depth < 3 && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(p, depth + 1);
      } else if (DEFINES.test(e.name)) addFile(p, into);
    }
  };
  walk(cwd, 0);
}

function addFile(p: string, into: Print): void {
  try {
    const st = statSync(p);
    if (!st.isFile()) return;
    // Past a megabyte it is named by its size and time: a script's own text is never that long.
    into.hash.update(`\0${into.name(p)}\0`).update(st.size > MAX_FILE ? `${st.size}:${st.mtimeMs}` : readFileSync(p));
  } catch {
    // Not there: nothing of it to run.
  }
}

function addDir(dir: string, into: Print): void {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) if (e.isFile() || e.isSymbolicLink()) addFile(path.join(dir, e.name), into);
  } catch {
    // No such folder: nothing of it to run.
  }
}

/**
 * Git's own say in what a git command runs: its hooks, and its settings but for the lines every new branch and remote write (which
 * branch follows which, a remote's address), so making a branch doesn't read as a change.
 */
function gitState(cwd: string, into: Print): void {
  let dir = path.join(cwd, ".git");
  let common = dir;
  try {
    // A worktree's .git is a file naming its own folder, whose settings and hooks are the main repository's.
    if (lstatSync(dir).isFile()) {
      dir = path.resolve(cwd, readFileSync(dir, "utf8").replace(/^gitdir:\s*/, "").trim());
      const c = readFileSync(path.join(dir, "commondir"), "utf8").trim();
      common = path.resolve(dir, c);
    }
  } catch {
    return;
  }
  for (const d of new Set([dir, common])) {
    try {
      let section = "";
      const kept = readFileSync(path.join(d, "config"), "utf8")
        .split("\n")
        .filter((line) => {
          const head = /^\s*\[(\w+)/.exec(line);
          if (head) section = head[1]!.toLowerCase();
          if (section === "branch" || !line.trim()) return false;
          return !(section === "remote" && /^\s*(url|fetch|pushurl|push|tagopt|prune)\s*=/i.test(line));
        });
      into.hash.update(`\0config\0${kept.join("\n")}`);
    } catch {
      // No settings of its own.
    }
    addDir(path.join(d, "hooks"), into);
    addFile(path.join(d, "info", "attributes"), into);
  }
  addFile(path.join(cwd, ".gitattributes"), into);
}

/** A secret under a folder that a search of every file in it would read, or "" for none. Stops at the first. */
function secretUnder(root: string, o: { hidden: boolean; follow: boolean; skipDirs: RegExp[]; skipFiles: RegExp[]; roots: string[] }): string {
  let seen = 0;
  const walk = (dir: string, depth: number): string => {
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const e of names) {
      // Too many to look through: not vouched for.
      if (++seen > 20_000) return "more files than could be checked";
      if (!o.hidden && e.name.startsWith(".")) continue;
      const isDir = e.isDirectory();
      if ((isDir ? o.skipDirs : o.skipFiles).some((re) => re.test(e.name))) continue;
      if (SECRET_NAME.test(e.name)) return e.name;
      if (e.isSymbolicLink() && o.follow) {
        const to = real(path.join(dir, e.name));
        if (to && !o.roots.some((r) => under(to, r))) return `${e.name} (a link out of the folder)`;
        continue;
      }
      if (isDir && e.name !== "node_modules" && depth < 8) {
        const hit = walk(path.join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };
  return walk(root, 0);
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

export interface AskFacts {
  /** A fingerprint of what the commands run in this project, when they run anything of its own. */
  scripts?: string;
  /** A secret, or a file outside the folder, one of them would read: its name, for the card. */
  secretRead?: string;
}

export function askFacts(commands: readonly string[], cwd: string, dirs: readonly string[] = []): AskFacts {
  const roots = [cwd, ...dirs].map((d) => real(d) ?? path.resolve(d));
  let git = false;
  let scripts = false;
  let secretRead = "";
  const run: string[] = [];
  for (const command of commands) {
    const line = lexLine(command.trim());
    // One the allow list can't read either: only ever allowed exactly as pressed. What it runs is not known, so all of it counts.
    if (!line) {
      git = scripts = true;
      continue;
    }
    let base = cwd;
    for (const piece of line.pieces) {
      let w = piece.words.map((x) => x.text);
      while (w.length > 1 && /^[A-Za-z_]\w*=/.test(w[0]!)) w = w.slice(1);
      const bin = path.basename(w[0] ?? "");
      const args = w.slice(1);
      const operands = args.filter((a) => a && !a.startsWith("-"));
      if (bin === "cd") {
        if (operands[0]) base = path.resolve(base, operands[0]);
        continue;
      }
      if (bin === "git") git = true;
      else if (!READS.has(bin)) {
        scripts = true;
        // A file it is handed to run (node build.js, sh run.sh, ./deploy.sh) is what it runs. Not a test runner's test files.
        if (/[\\/]/.test(w[0]!)) run.push(path.resolve(base, w[0]!));
        if (INTERPRETERS.test(bin) && operands[0] && !args.some((a) => a === "--test" || a === "-m" || a === "-c" || a === "-e")) run.push(path.resolve(base, operands[0]));
      }
      if (secretRead) continue;
      // A path that is, or goes through, a link to somewhere else: read by where it lands.
      for (const o of operands) {
        const p = path.resolve(base, o);
        const to = real(p);
        if (!to || to === p) continue;
        const rel = roots.map((r) => (under(to, r) ? path.relative(r, to) : null)).find((r) => r !== null);
        if (rel === undefined) secretRead = `${o} (a link out of the folder)`;
        else if (rel!.split(path.sep).some((seg) => SECRET_NAME.test(seg))) secretRead = `${o} (a link to ${path.basename(to)})`;
        if (secretRead) break;
      }
      if (secretRead) continue;
      // Every file under a folder: grep -r and -R, and ripgrep told to look at what it would skip.
      const short = (letters: string) => args.some((a) => /^-[A-Za-z.]+$/.test(a) && [...letters].some((l) => a.includes(l)));
      const long = (re: RegExp) => args.some((a) => re.test(a));
      // ripgrep skips hidden files and what Git ignores until told not to: -u once for the ignored, twice (or --hidden, -.) for both.
      const us = args.reduce((n, x) => n + (x === "--unrestricted" ? 1 : /^-[A-Za-z.]+$/.test(x) ? x.split("u").length - 1 : 0), 0);
      const hidden = bin === "grep" || long(/^--hidden$/) || short(".") || us >= 2;
      const follow = bin === "grep" ? short("R") || long(/^--dereference-recursive$/) : short("L") || long(/^--follow$/);
      const deep = bin === "grep" ? short("rR") || long(/^--(dereference-)?recursive$/) : bin === "rg" ? hidden || follow || us >= 1 || long(/^--no-ignore/) : false;
      if (!deep) continue;
      const value = (names: RegExp) => args.flatMap((a, i) => (names.test(a.split("=")[0]!) ? [a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[i + 1] ?? "")] : []));
      const skipDirs = bin === "grep" ? value(/^--exclude-dir$/).map(globRe) : [];
      const skipFiles = bin === "grep" ? value(/^--exclude$/).map(globRe) : [];
      // ripgrep's globs that leave out ("!.env", "!.git/"): by the name they end in.
      if (bin === "rg") for (const g of value(/^(-g|--glob)$/)) if (g.startsWith("!")) (g.endsWith("/") ? skipDirs : skipFiles).push(globRe(path.basename(g.slice(1))));
      // The first operand is what to look for (unless -e gave it); the rest are where, the folder itself when none.
      const where = args.some((a) => a === "-e" || /^-[A-Za-z]*e$/.test(a)) ? operands : operands.slice(1);
      // -e's own value is among the operands then: a pattern that is no path is simply not found, and nothing is read for it.
      for (const o of where.length ? where : ["."]) {
        const p = path.resolve(base, o);
        let isDir = false;
        try {
          isDir = statSync(p).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        const hit = secretUnder(p, { hidden, follow, skipDirs, skipFiles, roots });
        if (hit) {
          secretRead = `${hit}, under ${o}`;
          break;
        }
      }
    }
  }
  const out: AskFacts = {};
  if (git || scripts) {
    const hash = createHash("sha256");
    // Git's own folder may sit outside a copy (a worktree): named by its last parts.
    const h: Print = { hash, name: (p) => (under(p, cwd) ? path.relative(cwd, p) : p.split(path.sep).slice(-2).join("/")) };
    if (scripts) definingFiles(cwd, h);
    if (git) gitState(cwd, h);
    for (const p of [...new Set(run)].sort()) {
      try {
        if (statSync(p).isFile()) addFile(p, h);
      } catch {
        // Not a file here: a script's name, a package, a branch.
      }
    }
    out.scripts = hash.digest("hex").slice(0, 32);
  }
  if (secretRead) out.secretRead = secretRead.slice(0, 120);
  return out;
}
