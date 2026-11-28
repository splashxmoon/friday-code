import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionView } from "../runner/connections.js";
import { Button } from "@/components/ui/button";
import { Button as KitButton } from "@/components/affect/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { ClaudeMark } from "./BrandMarks.js";
import { Icon, type IconName } from "./icons.js";
import { hostApi } from "./local.js";
import { CATEGORIES, MCP_CATALOG, type CatalogEntry, type Category } from "./mcp-catalog.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";
import { Skeleton, SkeletonLines } from "./ui.js";

/**
 * The directory of services on the MCP servers page (Arun, 2026-11-17: "i want to add support for all of these btw.... like what
 * we had before... gmail, slack, github, linear, figma, stripe, etc, go all out for this"): the hosted edition's catalogue
 * (mcp-catalog.ts, every address checked with a real MCP handshake), connected from this computer for every coding tool here.
 *
 * - Most sign in with OAuth: the provider's page opens in the browser and comes back to this Friday (runner/connections.ts
 *   startSignin, app.ts /api/mcp/signed-in); the page follows until it's back.
 * - A few won't let an app register itself (Google, Slack, GitHub, HubSpot, Box, Zendesk, PagerDuty): the person registers
 *   one, in a few steps said here with the address to give it, and signs in with that. GitHub takes a personal access token too.
 * - A few take a key, and a few run on this computer (Figma's desktop server): their address can be changed.
 */

/** Where to register an app of your own, for a provider that won't register Friday by itself. */
const OWN_APP: Record<string, { where: string; how: string }> = {
  GOOGLE: { where: "https://console.cloud.google.com/apis/credentials", how: "Create an OAuth client ID of type Web application, add the address below as an authorised redirect URI, and turn on the Gmail or Calendar API for the project." },
  SLACK: { where: "https://api.slack.com/apps", how: "Create an app, add the address below under OAuth & Permissions as a redirect URL, then copy its client ID and secret from Basic Information." },
  GITHUB: { where: "https://github.com/settings/developers", how: "Make a new OAuth App with the address below as its callback URL. Or paste a personal access token instead, below." },
  HUBSPOT: { where: "https://developers.hubspot.com/", how: "Create an app, add the address below as a redirect URL, and copy its client ID and secret." },
  BOX: { where: "https://app.box.com/developers/console", how: "Create a Custom App using OAuth 2.0 with the address below as its redirect URI." },
  ZENDESK: { where: "https://support.zendesk.com/hc/en-us/articles/4408845965210", how: "In Admin Center, under Apps and integrations, add an OAuth client with the address below as its redirect URL." },
  PAGERDUTY: { where: "https://developer.pagerduty.com/", how: "Register an OAuth app with the address below as its redirect URL." },
};

const trim = (u: string) => u.replace(/\/+$/, "");
/** The server from a directory entry, when it's here: by the entry it came from, or its address. */
export const serverFor = (e: CatalogEntry, servers: ConnectionView[]) => servers.find((s) => s.catalog === e.id) ?? servers.find((s) => s.url && trim(s.url) === trim(e.url));

/** The service's own mark: its logo from its own site, the drawn mark until that loads or when it won't. */
export function ServiceMark({ entry, size = 20, tile = size + 14 }: { entry: CatalogEntry; size?: number; /** The tile around it: 28 on a card or a row, 36 at the head of its drawer. */ tile?: number }) {
  const sources = useMemo(() => [...(entry.logo ? [entry.logo] : []), ...(entry.domain ? [`https://${entry.domain}/favicon.ico`, `https://www.google.com/s2/favicons?domain=${entry.domain}&sz=64`] : [])], [entry]);
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = sources[step];
  return (
    <span className="mdir-mark" style={{ width: tile, height: tile }}>
      {(!src || !loaded) && <Icon name={entry.mark} size={size - 2} />}
      {src && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`${entry.invertLogo ? "mdir-invert" : ""}${loaded ? " loaded" : ""}`}
          onLoad={() => setLoaded(true)}
          onError={() => (setLoaded(false), setStep((n) => n + 1))}
        />
      )}
    </span>
  );
}

type Phase = { kind: "idle" } | { kind: "waiting"; url: string; since: number } | { kind: "busy" } | { kind: "error"; text: string };

/** One service's sheet: sign in, an app of your own, a key, or an address; and how it went. */
function ServiceSheet({ identity, entry, servers, builtIn, onClose, onChanged }: { identity: Identity; entry: CatalogEntry; servers: ConnectionView[]; /** Friday has its own app with this provider: one click, an app of one's own folded away. */ builtIn: boolean; onClose: () => void; onChanged: () => Promise<ConnectionView[]> }) {
  const here = serverFor(entry, servers);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(entry.url);
  const [copied, setCopied] = useState(false);
  const redirect = `${location.origin}/api/mcp/signed-in`;
  const [useOwn, setUseOwn] = useState(false);
  const own = entry.needsClient && (!builtIn || useOwn) ? OWN_APP[entry.needsClient] : undefined;
  const waitingFor = useRef(0);
  /** Connected, and asked to sign in or give its key again: the way in shows under what it has. */
  const [redo, setRedo] = useState(false);

  // While its sign-in is open in the browser, the list is read every two seconds until the server is back, for five minutes.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const since = phase.since;
    waitingFor.current = since;
    const t = setInterval(async () => {
      const list = await onChanged().catch(() => null);
      const s = list && serverFor(entry, list);
      if (s?.status && s.status.at >= since) {
        clearInterval(t);
        if (s.status.ok) setRedo(false);
        setPhase(s.status.ok ? { kind: "idle" } : { kind: "error", text: s.status.error ?? "It didn't answer after signing in." });
      }
      if (Date.now() - since > 5 * 60_000) (clearInterval(t), setPhase({ kind: "error", text: "The sign-in didn't come back. Start it again." }));
    }, 2000);
    return () => clearInterval(t);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = <T,>(op: string, body: unknown) => hostApi<T>(identity, `/api/runner/${op}`, { method: "POST", body: JSON.stringify(body) });
  const signIn = async (client?: { id: string; secret: string }) => {
    setPhase({ kind: "busy" });
    try {
      const r = await post<{ authorizeUrl: string }>("connections.signin", { url: entry.url, name: entry.id, catalog: entry.id, ...(here ? { id: here.id } : {}), ...(client ? { clientId: client.id, clientSecret: client.secret } : {}) });
      void openOutside(r.authorizeUrl);
      setPhase({ kind: "waiting", url: r.authorizeUrl, since: Date.now() });
    } catch (e) {
      setPhase({ kind: "error", text: (e as Error).message });
    }
  };
  /** Added with a key, or with nothing (a server on this computer), as a remote server. */
  const addDirect = async (key?: string) => {
    setPhase({ kind: "busy" });
    try {
      const transport = /\/sse\/?(\?|$)/i.test(url) ? "sse" : "http";
      if (here) await post("connections.remove", { id: here.id });
      const r = await post<{ server: ConnectionView }>("connections.add", { draft: { name: entry.id, transport, url: url.trim(), ...(key ? { headers: { Authorization: `Bearer ${key.trim()}` } } : {}), needs: [], catalog: entry.id }, values: {} });
      await onChanged();
      if (r.server.status?.ok) setRedo(false);
      setPhase(r.server.status?.ok ? { kind: "idle" } : { kind: "error", text: r.server.status?.error ?? "It didn't answer." });
    } catch (e) {
      setPhase({ kind: "error", text: (e as Error).message });
    }
  };

  const st = here?.status;
  // Connected when opened: its drawer from the right (the approved mock, 2026-11-27). Not yet: the sheet in the middle, to connect.
  const [drawer] = useState(!!here);
  return (
    <Frame drawer={drawer} onClose={onClose}>
        {drawer && here ? (
          <DrawerHead mark={<ServiceMark entry={entry} size={22} tile={36} />} name={entry.name} sub={subOf(here)} server={here} />
        ) : (
          <DialogHeader>
            <div className="mdir-sheet-head">
              <ServiceMark entry={entry} size={26} />
              <div>
                <DialogTitle>{entry.name}</DialogTitle>
                <DialogDescription>{entry.blurb}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
        )}

        {here && (
          <Manage
            identity={identity}
            server={here}
            name={entry.name}
            onChanged={onChanged}
            onGone={onClose}
            again={st?.ok && !redo && phase.kind !== "waiting" ? { label: entry.auth === "oauth" && !entry.local ? "Sign in again" : entry.auth === "token" ? "Change its key" : "Connect again", run: () => (entry.auth === "oauth" && !entry.local ? void signIn() : setRedo(true)) } : undefined}
          />
        )}

        {here && st?.ok && !redo && phase.kind !== "waiting" ? null : phase.kind === "waiting" ? (
          <div className="mdir-wait" role="status">
            <span className="spinner tiny" aria-hidden /> Finish signing in to {entry.name} in your browser. This updates by itself.
            <button type="button" className="link-btn" onClick={() => void openOutside(phase.url)}>
              Open it again
            </button>
          </div>
        ) : entry.local ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addDirect(token || undefined);
            }}
          >
            <p className="mdir-note">It runs on this computer: start it first, then connect.</p>
            <label className="mdir-field">
              <span>Address</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            </label>
            {entry.auth === "token" && (
              <label className="mdir-field">
                <span>Key{entry.tokenOptional ? " (optional)" : ""}</span>
                <input type="password" autoComplete="off" value={token} placeholder={entry.tokenHint ?? "Paste its key"} onChange={(e) => setToken(e.target.value)} />
              </label>
            )}
            <Button type="submit" disabled={phase.kind === "busy" || !url.trim()}>
              {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
            </Button>
          </form>
        ) : entry.auth === "token" ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addDirect(token || undefined);
            }}
          >
            <label className="mdir-field">
              <span>Key{entry.tokenOptional ? " (optional)" : ""}</span>
              <input type="password" autoComplete="off" value={token} placeholder="Paste its key" onChange={(e) => setToken(e.target.value)} />
            </label>
            {entry.tokenHint && <p className="mdir-note">{entry.tokenHint}</p>}
            <Button type="submit" disabled={phase.kind === "busy" || (!entry.tokenOptional && !token.trim())}>
              {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
            </Button>
          </form>
        ) : entry.auth === "none" ? (
          <Button disabled={phase.kind === "busy"} onClick={() => void addDirect()}>
            {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
          </Button>
        ) : own ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn({ id: clientId.trim(), secret: secret.trim() });
            }}
          >
            <p className="mdir-note">
              {entry.name} doesn't let apps register themselves, so it signs in with an app of yours.{" "}
              <button type="button" className="link-btn" onClick={() => void openOutside(own.where)}>
                Register one
              </button>
              : {own.how}
            </p>
            <label className="mdir-field">
              <span>Redirect address</span>
              <span className="mdir-copy">
                <code>{redirect}</code>
                <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(redirect).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </label>
            <label className="mdir-field">
              <span>Client ID</span>
              <input value={clientId} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className="mdir-field">
              <span>Client secret</span>
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <Button type="submit" disabled={phase.kind === "busy" || !clientId.trim()}>
              {phase.kind === "busy" ? "Opening…" : `Sign in to ${entry.name}`}
            </Button>
            {entry.needsClient === "GITHUB" && (
              <div className="mdir-or">
                <span>Or a personal access token</span>
                <span className="mdir-copy">
                  <input type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
                  <Button type="button" variant="outline" size="sm" disabled={!token.trim() || phase.kind === "busy"} onClick={() => void addDirect(token)}>
                    Connect
                  </Button>
                </span>
              </div>
            )}
          </form>
        ) : (
          <div className="mdir-form">
            {entry.localhostOnly && <p className="mdir-note">{entry.name} signs in apps that run on your own computer, as Friday does here.</p>}
            <Button disabled={phase.kind === "busy"} onClick={() => void signIn()}>
              {phase.kind === "busy" ? "Opening…" : here?.signedIn ? `Sign in to ${entry.name} again` : `Sign in to ${entry.name}`}
            </Button>
            {entry.needsClient && builtIn && (
              <button type="button" className="link-btn mdir-more" onClick={() => setUseOwn(true)}>
                Use an app of your own instead
              </button>
            )}
          </div>
        )}

        {phase.kind === "error" && phase.text !== st?.error && (
          <p className="mdir-state bad" role="alert">
            {phase.text}
          </p>
        )}
        <p className="mdir-foot">Every coding tool here gets it on its next turn. Its sign-in stays on this computer, in a file only you can read.</p>
    </Frame>
  );
}

/** A service's sheet: a drawer from the right for one connected, the dialog in the middle for one to connect. */
function Frame({ drawer, onClose, children }: { drawer: boolean; onClose: () => void; children: ReactNode }) {
  return drawer ? (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="mdir-sheet mdir-drawer">
        {children}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="mdir-sheet sm:max-w-[480px]">{children}</DialogContent>
    </Dialog>
  );
}

/** The drawer's head: its mark, its name with how it's connected under it, and its state. */
function DrawerHead({ mark, name, sub, server, mono }: { mark: ReactNode; name: string; sub: string; server: ConnectionView; /** What it runs, for one of your own. */ mono?: boolean }) {
  return (
    <div className="mdir-drawer-head">
      {mark}
      <span className="mdir-drawer-title">
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription className={mono ? "mdir-own-line" : undefined} title={mono ? sub : undefined}>
          {sub}
        </DialogDescription>
      </span>
      <StateChip state={stateOf(server)} />
    </div>
  );
}

/** How a connected service is in, in a line under its name: signed in or a key, and how many tools. */
function subOf(s: ConnectionView): string {
  const st = s.status;
  if (!st) return "Not tested yet";
  if (!st.ok) return st.kind === "auth" || st.kind === "signin" ? "Its sign-in or key was refused" : "It didn't answer";
  const n = st.tools ?? st.names?.length ?? 0;
  return `${s.signedIn ? "Signed in as you" : s.envKeys.length + s.headerKeys.length ? "With your key" : "Connected"} · ${n} tool${n === 1 ? "" : "s"}`;
}

/** What a server runs, in a line: the command and its arguments, or the address. */
export const lineOf = (s: Pick<ConnectionView, "transport" | "command" | "args" | "url">) => (s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? ""));

/** Who gets a server: every coding tool Friday runs mounts the list (runner/connections.ts), but Cursor reads only its own. */
const WHO: { tool: string; own?: true }[] = [{ tool: "Claude Code" }, { tool: "Codex" }, { tool: "Amp and the ACP tools" }, { tool: "Cursor", own: true }];

/**
 * What a connected server has, and the ways to manage it (Arun, 2026-11-17: "also add ability to disconnect/manage and stuff"),
 * as the approved mock's drawer lays it out (2026-11-27): who gets it, its tools, then Disconnect on the left and Test again and the
 * way back in (sign in again, a new key) on the right; Disconnect asks first, in place. Who gets it is one switch for every tool,
 * which is all the server's list holds: the tools under it say whether each gets it, with no switch of their own to pretend one.
 */
function Manage({ identity, server, name, again, onChanged, onGone }: { identity: Identity; server: ConnectionView; name: string; /** Signing in again, or a new key: what this kind of server takes. */ again?: { label: string; run: () => void }; onChanged: () => Promise<ConnectionView[]>; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [allTools, setAllTools] = useState(false);
  const run = async (op: "connections.update" | "connections.test" | "connections.remove", body: Record<string, unknown> = {}) => {
    setBusy(true);
    setErr("");
    try {
      await hostApi(identity, `/api/runner/${op}`, { method: "POST", body: JSON.stringify({ id: server.id, ...body }) });
      await onChanged();
      if (op === "connections.remove") onGone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const st = server.status;
  const names = st?.ok ? (st.names ?? []) : [];
  const shown = allTools ? names : names.slice(0, 5);
  return (
    <div className="mdir-manage">
      {st && !st.ok && st.error && <p className="mdir-why">{st.error}</p>}
      <span className="mdir-lbl">Who gets it</span>
      <div className="mdir-box">
        <label className="mdir-box-row mdir-toggle">
          <span>Every coding tool here</span>
          <Switch aria-label={`${name}: on for every tool`} checked={server.enabled} disabled={busy} onCheckedChange={(on) => void run("connections.update", { enabled: on })} />
        </label>
        {WHO.map((w) => (
          <div key={w.tool} className="mdir-box-row">
            <span>{w.tool}</span>
            <span className="mdir-faint">{w.own ? "Reads its own list" : server.enabled ? "Gets it" : "Off"}</span>
          </div>
        ))}
      </div>
      {names.length > 0 && (
        <>
          <span className="mdir-lbl">
            Tools <span className="mdir-num">{names.length}</span>
          </span>
          <ul className="mdir-box mdir-tools-list" aria-label="Its tools">
            {shown.map((n) => (
              <li key={n} className="mdir-box-row" title={toolWords(n)}>
                <code>{n}</code>
              </li>
            ))}
            {names.length > 5 && (
              <li>
                <button type="button" className="mdir-box-row mdir-box-more" aria-expanded={allTools} onClick={() => setAllTools((v) => !v)}>
                  {allTools ? "Show fewer" : `Show all ${names.length}`}
                  <Icon name={allTools ? "chevronUp" : "chevronDown"} size={13} />
                </button>
              </li>
            )}
          </ul>
        </>
      )}
      {/* Disconnecting asks first, in a panel of its own in the actions' place: the question, what it does, then Keep or Disconnect
          (Arun, 2026-11-17: "design the disconnect mcp confirmation layout better"). */}
      {confirmOff ? (
        <div className="mdir-confirm" role="group" aria-labelledby={`mdir-off-${server.id}`}>
          <div className="mdir-confirm-text">
            <b id={`mdir-off-${server.id}`}>Disconnect {name}?</b>
            <span>It comes off every coding tool here, and its key or sign-in is deleted from this computer.</span>
          </div>
          <div className="mdir-confirm-acts">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmOff(false)}>
              Keep
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run("connections.remove")}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mdir-manage-acts">
          <KitButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmOff(true)}>
            Disconnect
          </KitButton>
          <span className="mdir-grow" />
          <KitButton size="sm" variant="secondary" disabled={busy} icon={<Icon name="refresh" size={13} />} onClick={() => void run("connections.test")}>
            {busy ? "Checking…" : "Test again"}
          </KitButton>
          {again && (
            <KitButton size="sm" variant="secondary" disabled={busy} onClick={again.run}>
              {again.label}
            </KitButton>
          )}
        </div>
      )}
      {err && (
        <p className="mdir-state bad" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** A server of one's own, added from Custom server: what it runs, managed as a service is, its keys changed here. */
function OwnSheet({ identity, server, onClose, onChanged }: { identity: Identity; server: ConnectionView; onClose: () => void; onChanged: () => Promise<ConnectionView[]> }) {
  const [fixing, setFixing] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const hasKeys = server.envKeys.length + server.headerKeys.length > 0;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const env = Object.fromEntries(server.envKeys.map((k) => [k, keys[`env:${k}`] ?? ""]).filter(([, v]) => v.trim()));
      const headers = Object.fromEntries(server.headerKeys.map((k) => [k, keys[`header:${k}`] ?? ""]).filter(([, v]) => v.trim()));
      await hostApi(identity, "/api/runner/connections.update", { method: "POST", body: JSON.stringify({ id: server.id, env, headers, enabled: true }) });
      await onChanged();
      setFixing(false);
      setKeys({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame drawer onClose={onClose}>
        <DrawerHead mark={<OwnMark server={server} tile={36} />} name={server.name} sub={lineOf(server)} server={server} mono />
        <Manage identity={identity} server={server} name={server.name} onChanged={onChanged} onGone={onClose} again={hasKeys && !fixing ? { label: server.status?.kind === "auth" ? "Fix its keys" : "Change its keys", run: () => setFixing(true) } : undefined} />
        {fixing && (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {[...server.envKeys.map((k) => ["env", k] as const), ...server.headerKeys.map((k) => ["header", k] as const)].map(([w, k]) => (
              <label key={`${w}:${k}`} className="mdir-field">
                <span>
                  {k}
                  {w === "header" ? " (header)" : ""}
                </span>
                <input type="password" autoComplete="off" placeholder="New value, or leave it as it is" value={keys[`${w}:${k}`] ?? ""} onChange={(e) => setKeys((x) => ({ ...x, [`${w}:${k}`]: e.target.value }))} />
              </label>
            ))}
            <span className="mdir-manage-acts">
              <Button type="submit" size="sm" disabled={busy || !Object.values(keys).some((v) => v.trim())}>
                {busy ? "Testing…" : "Save and test"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => (setFixing(false), setKeys({}))}>
                Cancel
              </Button>
            </span>
            {err && (
              <p className="mdir-state bad" role="alert">
                {err}
              </p>
            )}
          </form>
        )}
        <p className="mdir-foot">Every coding tool here gets it on its next turn. Its keys stay on this computer, in a file only you can read.</p>
    </Frame>
  );
}

/** A server of one's own: drawn, a terminal for one that runs here, a link for one that's reached. */
function OwnMark({ server, tile }: { server: ConnectionView; tile: number }) {
  return (
    <span className="mdir-mark mdir-own" style={{ width: tile, height: tile }} aria-hidden="true">
      <Icon name={server.transport === "stdio" ? "terminal" : "link"} size={Math.round(tile / 2)} />
    </span>
  );
}

/** A tool's name in words: create_draft is "Create draft", hub_repo_search "Hub repo search". */
const toolWords = (n: string) => {
  const w = n.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * Services left out of this computer's directory for now, because none of them can be used from here yet (Arun, 2026-11-17:
 * "disable all of the google ones for now.... on the app and get rid of the ones we cannot use right now"): Google's Gmail,
 * Calendar and Chat servers answer calls only for Cloud projects in its Workspace Developer Preview; Calendly signs in only apps
 * at an https address; Similarweb's firewall refuses Friday. One already connected still shows, so it can be turned off or
 * removed. The hosted edition's catalogue keeps them.
 */
const NOT_HERE_YET = new Set(["gmail", "google-calendar", "google-chat", "calendly", "similarweb"]);

/** Each kind's icon in the filters. */
const KIND_ICON: Record<Category, IconName> = {
  "Files and docs": "folder",
  "Email and calendar": "mail",
  "Chat and meetings": "message",
  "Issues and projects": "kanban",
  "Sales and support": "headset",
  "Design and content": "image",
  "Code and docs": "code",
  "Data and money": "chart",
  Infrastructure: "server",
};

/** A server's state: connected, off, its sign-in or key refused (Needs sign in), or not answering. */
type State = "on" | "off" | "signin" | "bad";
const stateOf = (s: ConnectionView): State => (!s.status ? "off" : s.status.ok ? (s.enabled ? "on" : "off") : s.status.kind === "auth" || s.status.kind === "signin" ? "signin" : "bad");
const STATE_WORDS: Record<State, string> = { on: "Connected", off: "Off", signin: "Sign in again", bad: "Didn't answer" };

/** A state as a chip: green connected, amber when it needs you, grey off. Colour says state and nothing else. */
function StateChip({ state }: { state: State }) {
  return (
    <span className={`mdir-how ${state}`}>
      {state !== "off" && <i aria-hidden="true" />}
      {STATE_WORDS[state]}
    </span>
  );
}

/** A connected server in a line: how many tools, and who gets them; or why it isn't working. */
function metaOf(s: ConnectionView): string {
  const st = s.status;
  if (!st) return "Not tested yet";
  if (!st.ok) return st.error ?? "It didn't answer.";
  const n = st.tools ?? st.names?.length ?? 0;
  return `${n} tool${n === 1 ? "" : "s"} · ${s.enabled ? "every coding tool" : "off for every tool"}`;
}

/** How a service connects: its chip when that's worth saying (Your app, Runs here), its card's one button, and the line beside it. */
function howOf(e: CatalogEntry, builtIn: boolean): { chip?: string; act: string; hint: string } {
  if (e.local) return { chip: "Runs here", act: "Set up", hint: "Runs on this computer" };
  if (e.auth === "token") return e.tokenOptional ? { act: "Connect", hint: "A key is optional" } : { act: "Add key", hint: "With a key of yours" };
  if (e.auth === "none") return { act: "Connect", hint: "Nothing to sign in to" };
  if (e.needsClient && !builtIn) return { chip: "Your app", act: "Connect", hint: "With an app of yours" };
  return { act: "Sign in", hint: `Sign in with ${e.name}` };
}

type Kind = Category | "" | "connected" | "signin";

/**
 * The directory (Arun, 2026-11-17: "redesign this better please..... looks too much, like better filters, layout and everythign....
 * also show all of them and add better design details too"), as the approved Customize mock draws it (2026-11-27: "good!"): one
 * header line (the switch, the search with its / key, then the page's actions), the kinds down a rail with their counts, and every
 * service as a card with one button. Your own tools are not over the catalogue (Arun, 2026-11-27: "i dont want the connected
 * plugins to be at the top i want to add something to view your connected tools"): Connected and Needs sign in head the rail,
 * under Yours, and open a list of only yours, what you connected through Friday and then what your coding tools brought; a card
 * for one already connected says so, with Manage.
 */
export function Directory({
  identity,
  servers: read,
  builtInApps,
  claudeCodeNames,
  lead,
  actions,
  trouble,
  onChanged,
  onCustom,
}: {
  identity: Identity;
  /** What this computer has connected; null until it has been read, when every card would say "not connected" and then flip. */
  servers: ConnectionView[] | null;
  /** The providers Friday signs in to with its own app (runner/builtin-apps.ts). */ builtInApps: string[];
  /** Claude Code's own servers, while they're handed to the other tools too (McpServers.tsx ClaudeCodeSwitch). */ claudeCodeNames: string[];
  /** The header line's start: Customize's switch (customize-switch.tsx). */ lead?: ReactNode;
  /** The header line's end: the Claude Code switch and Custom server (McpServers.tsx). */ actions?: ReactNode;
  /** Why the list couldn't be read, with Try again: in the cards' place before it ever was, over them after. */
  trouble?: ReactNode;
  onChanged: () => Promise<ConnectionView[]>;
  /** Custom server's sheet, from a search that found nothing. */ onCustom: () => void;
}) {
  const servers = read ?? [];
  const [q, setQ] = useState("");
  const [picked, setKind] = useState<Kind>("");
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const [openOwn, setOpenOwn] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();
  // / searches, as on Skills; Escape in the search clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      search.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // Its name, what it does, its kind, and its address, so "google" finds Gmail.
  const matches = (e: CatalogEntry) => !needle || `${e.name} ${e.blurb} ${e.category} ${e.url ?? ""}`.toLowerCase().includes(needle);
  const catalog = MCP_CATALOG.filter((e) => !NOT_HERE_YET.has(e.id) || serverFor(e, servers));
  const entryOf = (s: ConnectionView) => MCP_CATALOG.find((e) => serverFor(e, [s]));
  // Yours: every server connected through Friday, the directory's and your own (Custom server), in the order they were added.
  const nameOf = (s: ConnectionView) => entryOf(s)?.name ?? s.name;
  const mineMatch = (s: ConnectionView) => !needle || `${nameOf(s)} ${lineOf(s)}`.toLowerCase().includes(needle);
  const signin = servers.filter((s) => stateOf(s) === "signin");
  const theirs = claudeCodeNames.filter((n) => !needle || n.toLowerCase().includes(needle));
  const yours = servers.length + claudeCodeNames.length > 0;
  // The last one disconnected, or signed back in, while looking at them: back to what's left.
  const kind: Kind = picked === "signin" && !signin.length ? (yours ? "connected" : "") : picked === "connected" && !yours ? "" : picked;
  const cards = catalog.filter((e) => (!kind || e.category === kind) && matches(e));
  const allFound = catalog.filter(matches).length;
  const ownOpen = servers.find((s) => s.id === openOwn);
  const openServer = (s: ConnectionView) => {
    const e = entryOf(s);
    if (e) setOpen(e);
    else setOpenOwn(s.id);
  };

  const card = (e: CatalogEntry) => {
    const s = serverFor(e, servers);
    const state = s ? stateOf(s) : null;
    const builtIn = !!e.needsClient && builtInApps.includes(e.needsClient);
    const how = howOf(e, builtIn);
    const manage = state === "on" || state === "off";
    return (
      // The whole card opens it for a pointer; its one button is the way in for the keyboard and a screen reader.
      <li key={e.id} className={`mdir-card${state ? ` is-${state}` : ""}`} onClick={() => setOpen(e)}>
        <span className="mdir-card-top">
          <ServiceMark entry={e} size={16} tile={28} />
          <b className="mdir-name">{e.name}</b>
          {state ? <StateChip state={state} /> : how.chip && <span className="mdir-how">{how.chip}</span>}
        </span>
        <span className="mdir-blurb">{e.blurb}</span>
        <span className="mdir-card-foot">
          <span className={`mdir-card-hint${s ? " is-on" : ""}`}>{s ? metaOf(s) : how.hint}</span>
          <KitButton
            size="sm"
            variant={manage ? "ghost" : "secondary"}
            className="mdir-act"
            aria-label={`${e.name}: ${state === "on" ? "connected, manage" : state === "off" ? "off, manage" : state ? "needs you" : how.act.toLowerCase()}`}
            onClick={(ev) => (ev.stopPropagation(), setOpen(e))}
          >
            {manage ? "Manage" : state ? "Sign in" : how.act}
          </KitButton>
        </span>
      </li>
    );
  };
  // One of yours in the Connected list: its mark, its name, how many tools and who gets them, its state; it opens its drawer.
  const row = (s: ConnectionView) => {
    const e = entryOf(s);
    const state = stateOf(s);
    const name = nameOf(s);
    return (
      <li key={s.id}>
        <button type="button" className="mdir-row" onClick={() => openServer(s)} aria-label={`${name}: ${state === "on" ? "connected" : state === "off" ? "off" : "needs you"}, manage`}>
          {e ? <ServiceMark entry={e} size={16} tile={28} /> : <OwnMark server={s} tile={28} />}
          <span className="mdir-row-text">
            <b>{name}</b>
            <span>{metaOf(s)}</span>
          </span>
          <StateChip state={state} />
          <Icon name="chevronRight" size={14} className="mdir-row-chev" />
        </button>
      </li>
    );
  };
  const filter = (id: Kind, label: string, n: number, icon: ReactNode, amber = false) => (
    <button key={id || "all"} type="button" className={`mdir-filter${n ? "" : " none"}`} aria-pressed={kind === id} onClick={() => setKind(id)}>
      {icon}
      <span>{label}</span>
      <span className={`mdir-count${amber && n ? " is-amber" : ""}`}>{n}</span>
    </button>
  );
  const shownMine = kind === "signin" ? signin.filter(mineMatch) : servers.filter(mineMatch);
  return (
    <section className="mdir" aria-label="Connect a service">
      {/* One line (the approved mock, 2026-11-27): Customize's switch, the search on the left as the other pages have it (Arun,
          2026-11-19: "move the search bar on the mcp page to the left side of the page too, like how it is on other pages"), then
          the page's actions, the white one at the right end. How many services is in the search's placeholder. */}
      <div className="mdir-head">
        {lead}
        <label className="mdir-search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            type="search"
            placeholder={`Search ${catalog.length} services`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && q && (e.stopPropagation(), setQ(""))}
            aria-label="Search services"
          />
          {!q && <kbd className="mdir-kbd">/</kbd>}
        </label>
        <span className="mdir-grow" />
        <div className="mdir-head-acts">{actions}</div>
      </div>
      {read === null ? (
        // Until this computer says what it has connected: the page in its own shape, the kinds down the side and cards in their
        // grid, so nothing says "not connected" a moment before it says Connected. Or, if it couldn't be read, why, in their place.
        <div className="mdir-body">
          <div className="mdir-filters mdir-skel-filters" aria-hidden="true">
            {[58, 74, 0, 92, 80, 66, 98, 72].map((w, i) => (w ? <Skeleton key={i} w={`${w}%`} h={12} className="mdir-skel-filter" /> : <span key={i} className="mdir-sep" />))}
          </div>
          {trouble ?? (
            <div className="mdir-list" role="status" aria-label="Reading your plugins">
              <ul className="mdir-cards" aria-hidden="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <li key={i} className="mdir-card mdir-card-skel">
                    <span className="mdir-card-top">
                      <Skeleton w={28} h={28} r={7} />
                      <Skeleton w={`${40 + ((i * 13) % 30)}%`} h={12} />
                    </span>
                    <SkeletonLines lines={2} gap={6} />
                    <span className="mdir-card-foot">
                      <Skeleton w={56} h={24} r={6} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="mdir-body mdir-landed">
          <nav className="mdir-filters" aria-label="Kinds of service">
            {yours && (
              <>
                <span className="mdir-rail-label">Yours</span>
                {filter("connected", "Connected", servers.filter(mineMatch).length, <CircleCheckIcon aria-hidden="true" />)}
                {signin.length > 0 && filter("signin", "Needs sign in", signin.filter(mineMatch).length, <CircleAlertIcon aria-hidden="true" />, true)}
                <span className="mdir-rail-label">Add more</span>
              </>
            )}
            {filter("", "All", allFound, <Icon name="grid" size={14} />)}
            {CATEGORIES.filter((c) => catalog.some((e) => e.category === c)).map((c) => filter(c, c, catalog.filter((e) => e.category === c && matches(e)).length, <Icon name={KIND_ICON[c]} size={14} />))}
          </nav>
          {kind === "connected" || kind === "signin" ? (
            <div className="mdir-list mdir-yours" key={kind}>
              {trouble}
              <section className="mdir-group" aria-label={kind === "connected" ? "Connected" : "Needs sign in"}>
                <h3 className="mdir-sec-h">
                  <b>{kind === "connected" ? "Connected" : "Needs sign in"}</b>
                  <span className="mdir-sec-n">{shownMine.length}</span>
                  <span>{kind === "connected" ? "Every coding tool on this computer gets these unless you turn one off" : "Sign in again and every coding tool has them back"}</span>
                </h3>
                {shownMine.length ? <ul className="mdir-rows">{shownMine.map(row)}</ul> : <p className="mdir-empty">{needle ? `None of yours matches “${q.trim()}”.` : "Nothing connected through Friday yet. Pick a service under Add more."}</p>}
              </section>
              {kind === "connected" && theirs.length > 0 && (
                <section className="mdir-group" aria-label="From your coding tools">
                  <h3 className="mdir-sec-h">
                    <b>From your coding tools</b>
                    <span className="mdir-sec-n">{theirs.length}</span>
                    <span>Servers Claude Code already has, shown while its switch is on</span>
                  </h3>
                  {/* Claude Code's own: Friday hands them on, but they're managed in Claude Code, so a row here has nothing to open. */}
                  <ul className="mdir-rows">
                    {theirs.map((n) => (
                      <li key={n} className="mdir-row is-static">
                        <span className="mdir-mark mdir-own" style={{ width: 28, height: 28 }} aria-hidden="true">
                          <ClaudeMark size={14} />
                        </span>
                        <span className="mdir-row-text">
                          <b>{n}</b>
                          <span>Claude Code</span>
                        </span>
                        <span className="mdir-how">Claude Code's</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <div className="mdir-list" key={kind || "all"}>
              {trouble}
              {cards.length ? (
                <ul className="mdir-cards" aria-label={kind || "Every service"}>
                  {cards.map(card)}
                </ul>
              ) : kind && allFound ? (
                <div className="mdir-none">
                  <b>
                    None in {kind} called “{q.trim()}”
                  </b>
                  <span>
                    {allFound} in other kinds {allFound === 1 ? "is" : "are"}.
                  </span>
                  <KitButton size="sm" variant="secondary" onClick={() => setKind("")}>
                    Show all {allFound}
                  </KitButton>
                </div>
              ) : (
                <div className="mdir-none">
                  <b>No service called “{q.trim()}”</b>
                  <span>Check the spelling, or add any MCP server yourself.</span>
                  <KitButton size="sm" variant="secondary" icon={<Icon name="plus" size={14} />} onClick={onCustom}>
                    Custom server
                  </KitButton>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {ownOpen && <OwnSheet identity={identity} server={ownOpen} onClose={() => setOpenOwn("")} onChanged={onChanged} />}
      {open && <ServiceSheet identity={identity} entry={open} servers={servers} builtIn={!!open.needsClient && builtInApps.includes(open.needsClient)} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </section>
  );
}
