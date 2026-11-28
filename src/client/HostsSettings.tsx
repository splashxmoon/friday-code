import { useEffect, useState } from "react";
import { Icon } from "./icons.js";
import { hostLine, openHost, type AddJob, type HostView } from "./hosts.js";
import { MenuButton, Picker, relTime } from "./ui.js";

/**
 * Your Fridays on other machines (local/hosts.ts, spec 15; Arun, 2026-11-26: "we need proper infrastructure and setup for this to
 * work"), as parts of Settings › Other computers (ComputersSettings.tsx) since Arun asked the same day: "what is the difference
 * between like the host and other computers??? can we somehow combine them". A host is the computer that "runs on its own": its
 * row in the one list (HostRow), and the adding over SSH that "Run on its own" opens (HostAdd), each step said as it goes.
 */
const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-friday-local": "1", ...(init.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Friday said ${r.status}.`);
  return j;
};

function StepMark({ state }: { state: AddJob["steps"][number]["state"] }) {
  if (state === "done") return <span className="host-step-mark done" aria-label="Done"><Icon name="check" size={11} /></span>;
  if (state === "doing") return <span className="host-step-mark doing" aria-label="Working on it" />;
  if (state === "failed") return <span className="host-step-mark failed" aria-label="Failed"><Icon name="x" size={11} /></span>;
  return <span className="host-step-mark waiting" aria-label="Waiting" />;
}

/** Setting one up, or updating Friday on one: the job, followed every second until it's done. */
export function useHostSetup(reload: () => void) {
  const [job, setJob] = useState<AddJob | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!job || job.done) return;
    const t = setInterval(() => void api<AddJob>(`/api/hosts/jobs/${job.id}`).then(setJob, () => {}), 1_000);
    return () => clearInterval(t);
  }, [job?.id, job?.done]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (job?.done) reload();
  }, [job?.done]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (what: { ssh: string; label?: string } | HostView) => {
    setErr("");
    try {
      setJob("id" in what ? await api<AddJob>(`/api/hosts/${what.id}/update`, { method: "POST" }) : await api<AddJob>("/api/hosts", { method: "POST", body: JSON.stringify({ ssh: what.ssh.trim(), ...(what.label?.trim() ? { label: what.label.trim() } : {}) }) }));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    }
  };
  const clear = () => (setJob(null), setErr(""));
  return { job, err, start, clear };
}
export type HostSetup = ReturnType<typeof useHostSetup>;

/** "Run on its own": the machine as ssh takes it (or picked from ~/.ssh/config), then each step as Friday sets it up there. */
export function HostAdd({ setup, ssh, hosts, onDone }: { setup: HostSetup; ssh: string[]; hosts: HostView[]; onDone: () => void }) {
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const { job, err } = setup;
  const go = () => target.trim() && void setup.start({ ssh: target, label });
  // Tried again: an update of one already added, or the adding once more.
  const existing = job ? hosts.find((h) => h.ssh === job.ssh) : undefined;
  return (
    <div className="hosts-add" aria-label="Run on its own">
      {!job ? (
        <>
          <p className="muted small">A Mac or Linux machine you reach over SSH: a cloud VM, a Mac mini, a box at home. Friday installs itself there and keeps running as a service. It needs Node.js 22 and git there.</p>
          <div className="hosts-add-row">
            {ssh.length > 0 && <Picker className="hosts-pick" value={ssh.includes(target) ? target : ""} label="A host from your SSH config" placeholder="Your SSH hosts" onChange={(h) => setTarget(h)} options={ssh.map((h) => ({ value: h, label: h }))} />}
            <input className="input hosts-target" value={target} placeholder="user@machine or an alias" spellCheck={false} aria-label="The machine, as ssh takes it" onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
            <input className="input hosts-label" value={label} placeholder="Name (optional)" maxLength={40} aria-label="What to call it" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          </div>
          <div className="hosts-add-foot">
            <span className="muted small">Your logins aren't copied: sign in to Claude Code or Codex there, from its own screen.</span>
            <span className="hosts-add-acts">
              <button type="button" className="btn primary small" disabled={!target.trim()} onClick={go}>
                Set it up
              </button>
            </span>
          </div>
        </>
      ) : (
        <>
          <ol className="hosts-steps" aria-label={`Setting up ${job.ssh}`}>
            {job.steps.map((s) => (
              <li key={s.id} className={`hosts-step ${s.state}`}>
                <StepMark state={s.state} />
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
          {job.error && <p role="alert" className="error small hosts-said">{job.error}</p>}
          {job.warn && <p className="small hosts-said warn">{job.warn}</p>}
          <div className="hosts-add-foot">
            <span className="muted small">{job.done ? (job.error ? "" : `${job.host?.label ?? job.ssh} is ready. Sign in to your coding tools there from its own screen.`) : "Installing takes a minute or two the first time."}</span>
            <span className="hosts-add-acts">
              {job.done && (
                <button type="button" className="btn ghost small" onClick={onDone}>
                  {job.error ? "Close" : "Done"}
                </button>
              )}
              {job.done && job.error && (
                <button type="button" className="btn small" onClick={() => void setup.start(existing ?? { ssh: job.ssh, label })}>
                  Try again
                </button>
              )}
              {job.done && job.host && (
                <button type="button" className="btn primary small" onClick={() => (openHost(job.host!), onDone())}>
                  Open {job.host.label}
                </button>
              )}
            </span>
          </div>
        </>
      )}
      {err && <p role="alert" className="error small hosts-said">{err}</p>}
    </div>
  );
}

/** One machine that runs on its own, in Other computers' list: where it stands, Open, and the rest under its menu. */
export function HostRow({ h, reload, onUpdate, onSaid }: { h: HostView; reload: () => void; onUpdate: (h: HostView) => void; onSaid: (said: string, bad?: boolean) => void }) {
  const [naming, setNaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ unreachable?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rename = async () => {
    const n = naming;
    setNaming(null);
    if (!n?.trim()) return;
    await api(`/api/hosts/${h.id}`, { method: "PATCH", body: JSON.stringify({ label: n }) }).catch((e: Error) => onSaid(e.message, true));
    reload();
  };
  const remove = async (forget = false) => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; error?: string; unreachable?: boolean; left?: string }>(`/api/hosts/${h.id}${forget ? "?forget=1" : ""}`, { method: "DELETE" });
      if (r.ok) (setRemoving(null), onSaid(`${h.label} is removed. ${r.left ?? ""}`.trim()));
      else if (r.unreachable) setRemoving({ unreachable: r.error ?? "" });
      else onSaid(r.error ?? "Couldn't remove it.", true);
    } catch (e) {
      onSaid((e as Error).message, true);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const reconnect = () => void api(`/api/hosts/${h.id}/reconnect`, { method: "POST" }).then(reload, () => {});
  return (
    <li className="computers-host">
      <span className={`computers-dot${h.link === "up" ? " on" : ""}`} aria-hidden />
      <span className="computers-who">
        {naming !== null ? (
          <input className="input computers-rename" autoFocus value={naming} maxLength={40} aria-label={`A name for ${h.label}`} onChange={(e) => setNaming(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => (e.key === "Enter" ? void rename() : e.key === "Escape" ? setNaming(null) : undefined)} />
        ) : (
          <span className="computers-name" title={h.label}>
            {h.label}
          </span>
        )}
        {/* One line under its name: what runs there and where it is, or, when it can't be reached, why (less text, 2026-11-25). */}
        {h.link === "up" ? (
          <span className="muted small computers-detail">{[h.running ? `${h.running} running` : "", `${h.ssh} over SSH`, h.version ? `Friday ${h.version}` : "", h.how === "background" ? "not a service" : ""].filter(Boolean).join(" · ")}</span>
        ) : (
          <span className={`small computers-detail${h.link === "down" ? " bad" : " muted"}`} title={h.error ?? ""}>
            {hostLine(h)}
            {h.lastSeen ? ` · last seen ${relTime(h.lastSeen)} ago` : ""}
          </span>
        )}
      </span>
      <span className="computers-kind">On its own</span>
      <span className="computers-acts">
        {h.link === "down" ? (
          <button type="button" className="btn small" onClick={reconnect}>
            Reconnect
          </button>
        ) : (
          <button type="button" className="btn small" disabled={h.link !== "up"} onClick={() => openHost(h)}>
            Open
          </button>
        )}
        <MenuButton
          className="icon-btn tiny"
          label={`${h.label}: more`}
          end
          compact
          width={240}
          items={() => [
            { label: "Reconnect", icon: "refresh", onSelect: reconnect },
            { label: "Update Friday there", icon: "download", sub: "Installs this computer's Friday there again", onSelect: () => onUpdate(h) },
            { label: "Rename", icon: "pencil", onSelect: () => setNaming(h.label) },
            { label: "Remove", icon: "trash", danger: true, sub: "Stops Friday there; its sessions stay on the box", onSelect: () => setRemoving({}) },
          ]}
        />
      </span>
      {removing && (
        <p className="hosts-confirm small">
          {removing.unreachable ? removing.unreachable : `Stops Friday on ${h.ssh} and takes it off there. Its sessions and settings stay on the box.`}
          <span className="hosts-confirm-acts">
            <button type="button" className="btn ghost small" onClick={() => setRemoving(null)}>
              Keep
            </button>
            <button type="button" className="btn destructive small" disabled={busy} onClick={() => void remove(!!removing.unreachable)}>
              {busy ? <span className="spinner tiny" /> : null}
              {removing.unreachable ? "Remove from here" : "Remove"}
            </button>
          </span>
        </p>
      )}
      {h.warn && h.link === "up" && <p className="small hosts-warn">{h.warn}</p>}
    </li>
  );
}
