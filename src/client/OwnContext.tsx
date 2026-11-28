import { useEffect, useState } from "react";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import type { ContextInfo, WindowChange } from "../runner/own-context.js";
import "./own-context.css";

/**
 * A local model's Context, in Settings › Your models (HANDOFF-local-models-2026-11-28, phase 3; the mock's section 2A): the window
 * it runs at, what each size would take in memory here against what the GPU may use, what happens when it fills, which model
 * writes its summaries, and the room kept for its reply. A new window is shown before it's applied (the change, in the file it's
 * made in), and applied only where Friday can do it cleanly (runner/own-context.ts).
 */

const k = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const WHEN: { id: "compact" | "ask" | "drop"; label: string }[] = [
  { id: "compact", label: "Compact at 75%" },
  { id: "ask", label: "Only when I ask" },
  { id: "drop", label: "Drop old turns" },
];
const REPLY = [2048, 4096, 8192];
const SERVER: Record<string, string> = { llamacpp: "llama.cpp", ollama: "Ollama", lmstudio: "LM Studio" };

export function OwnContext({ identity, id, name, others }: { identity: Identity; id: string; name: string; /** Its owner's other models, for Summarise with. */ others: { id: string; name: string }[] }) {
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<number | null>(null);
  const [shown, setShown] = useState<WindowChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const call = <T,>(op: string, body: unknown) => hostApi<T>(identity, `/api/runner/${op}`, { method: "POST", body: JSON.stringify(body) });
  const load = () =>
    call<ContextInfo>("models.own.context", { id }).then(
      (i) => (setInfo(i), setErr("")),
      (e: Error) => setErr(e.message),
    );
  useEffect(() => void load(), [id]);

  if (err) return <div className="oc oc-err" role="alert">Couldn't read its context: {err}</div>;
  if (!info) return <div className="oc oc-loading" role="status">Reading its context…</div>;

  const prefs = { whenFull: info.prefs.whenFull ?? "compact", reply: info.prefs.reply ?? 4096, summarizer: info.prefs.summarizer ?? "" };
  const save = async (p: Partial<typeof prefs>) => {
    setInfo({ ...info, prefs: { ...info.prefs, ...p } });
    await call("models.own.context.save", { id, prefs: p }).catch((e: Error) => setSaid(e.message));
  };
  const now = info.window;
  const want = pick ?? now;
  const chosen = info.sizes.find((s) => s.size === want) ?? null;
  const bar = chosen?.bytes && info.file ? { model: info.file.bytes, ctx: chosen.bytes - info.file.bytes - 1.5e9, work: 1.5e9 } : null;
  const scale = Math.max(info.gpu * 1.12, chosen?.bytes ?? 0);
  const pct = (b: number) => `${Math.max(0, (b / scale) * 100)}%`;
  const changing = pick !== null && pick !== now;
  const show = async (apply: boolean) => {
    if (!changing) return;
    setBusy(true);
    setSaid("");
    const r = await call<{ change?: WindowChange; applied?: boolean; says?: string; window?: number | null }>("models.own.context.save", { id, window: pick, apply }).catch((e: Error) => ({ says: e.message }) as { change?: WindowChange; applied?: boolean; says?: string });
    setBusy(false);
    if (r.change) setShown(r.change);
    if (apply) {
      if (r.applied) {
        setSaid(`It runs at ${pick!.toLocaleString("en-US")} tokens now.`);
        setPick(null);
        setShown(null);
        void load();
      } else setSaid(r.says ?? "");
    }
  };
  const hybrid = info.kv && info.kv.fullLayers < info.kv.layers;

  return (
    <div className="oc" aria-label={`${name} context`}>
      <div className="oc-row">
        <div className="oc-label">
          <b>Context window</b>
          <span>{now ? `Now ${now.toLocaleString("en-US")} tokens.` : "Its server doesn't say yet."}{info.trained ? ` The model can take up to ${info.trained.toLocaleString("en-US")}.` : ""}</span>
        </div>
        <div className="oc-ctl">
          {info.sizes.length ? (
            <div className="oc-seg" role="radiogroup" aria-label="Context window">
              {info.sizes.map((s) => (
                <button key={s.size} type="button" role="radio" aria-checked={want === s.size} disabled={s.fit === "no"} className={s.fit === "tight" ? "tight" : ""} title={s.bytes ? `${gb(s.bytes)} in all${s.fit === "tight" ? ", tight" : s.fit === "no" ? ", won't fit here" : ""}` : undefined} onClick={() => (setPick(s.size), setShown(null), setSaid(""))}>
                  {k(s.size)}
                </button>
              ))}
            </div>
          ) : (
            <span className="oc-note">{info.note ?? "Friday reads its window from its server."}</span>
          )}
          {bar && (
            <>
              <div className="oc-bar" aria-hidden>
                <i className="m" style={{ width: pct(bar.model) }} />
                <i className="c" style={{ width: pct(bar.ctx) }} />
                <i className="w" style={{ width: pct(bar.work) }} />
                <em style={{ left: pct(info.gpu) }} />
              </div>
              <div className="oc-legend">
                <span><i className="m" />Model {gb(bar.model)}</span>
                <span><i className="c" />Context {gb(bar.ctx)}</span>
                <span><i className="w" />Working {gb(bar.work)}</span>
              </div>
              <p className="oc-note">Mark: what the GPU can use, about {Math.round(info.gpu / 1e9)} GB of {Math.round(info.total / 1e9)} GB.</p>
            </>
          )}
          {info.kv && (
            <p className="oc-note">
              {hybrid ? `This model is a hybrid: only ${info.kv.fullLayers} of its ${info.kv.layers} layers keep a growing cache, so each` : "Each"} extra 32k costs about {gb(info.kv.perToken * 32_768)}.
              {(() => {
                const tight = info.sizes.filter((s) => s.fit === "tight").map((s) => k(s.size));
                const no = info.sizes.filter((s) => s.fit === "no").map((s) => k(s.size));
                return `${tight.length ? ` ${tight.join(", ")} fits but leaves little for other apps.` : ""}${no.length ? ` ${no.join(", ")} won't fit here.` : ""}`;
              })()}
            </p>
          )}
        </div>
      </div>

      <div className="oc-row">
        <div className="oc-label">
          <b>When it fills up</b>
          <span>Before a turn that would go past the mark.</span>
        </div>
        <div className="oc-ctl">
          <div className="oc-seg" role="radiogroup" aria-label="When it fills up">
            {WHEN.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={prefs.whenFull === w.id} onClick={() => void save({ whenFull: w.id })}>
                {w.label}
              </button>
            ))}
          </div>
          <p className="oc-note">{prefs.whenFull === "drop" ? "Drop old turns is the old behaviour: faster, but it forgets what it did." : prefs.whenFull === "ask" ? "It keeps every turn until you press Compact now (or type /compact), then fits what's left." : "The same model summarises the older turns, and you can open or undo the summary in the thread."}</p>
        </div>
      </div>

      <div className="oc-row">
        <div className="oc-label">
          <b>Summarise with</b>
          <span>The model that writes the summary.</span>
        </div>
        <div className="oc-ctl">
          <select className="oc-select" aria-label="Summarise with" value={prefs.summarizer} onChange={(e) => void save({ summarizer: e.target.value })}>
            <option value="">Same model</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {info.server === "llamacpp" && others.length > 0 && <p className="oc-note">llama.cpp keeps one model loaded at a time here, so another model costs a reload each time; the same model is quicker.</p>}
        </div>
      </div>

      <div className="oc-row">
        <div className="oc-label">
          <b>Room for its reply</b>
          <span>Kept free in every request.</span>
        </div>
        <div className="oc-ctl">
          <div className="oc-seg" role="radiogroup" aria-label="Room for its reply">
            {REPLY.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={prefs.reply === r} onClick={() => void save({ reply: r })}>
                {k(r)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(changing || said) && (
        <div className="oc-foot">
          {changing && (
            <p>
              {k(pick!)} needs {info.server ? SERVER[info.server] : "its server"} to load this model again.
              {info.server === "llamacpp" && info.preset && !shown ? (
                <>
                  {" "}Friday changes <code>c = {pick}</code> under <code>[{name}]</code> in {info.preset.path.split(/[\\/]/).pop()}.
                </>
              ) : null}
            </p>
          )}
          {shown && (
            <div className="oc-change">
              {shown.file && (
                <pre>
                  {`${shown.file}\n[${shown.section}]\n${shown.before ? `- c = ${shown.before}\n` : ""}+ ${shown.line}`}
                </pre>
              )}
              <p>{shown.says}</p>
              {shown.command && <pre>{shown.command}</pre>}
            </div>
          )}
          {said && <p className="oc-said" role="status">{said}</p>}
          {changing && (
            <div className="oc-acts">
              <button type="button" className="btn small" disabled={busy} onClick={() => void show(false)}>
                Show the change
              </button>
              <button type="button" className="btn small primary" disabled={busy || (shown?.how === "manual")} onClick={() => void show(true)}>
                {busy ? "Applying…" : "Apply and reload"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
