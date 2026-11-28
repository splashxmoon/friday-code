import { useEffect, useRef, useState } from "react";
import { call } from "./Computers.js";
import { pollWhileShown } from "./app-push.js";
import { Icon } from "./icons.js";

/**
 * Linking a computer in two clicks (local/nearby.ts; Arun, 2026-11-21: "make it way easier to link up machines too"): Add a
 * computer › Nearby lists the Fridays on this network, Link offers one this computer's pairing, and that one asks its person
 * (LinkOffers, below) for the code this one shows: typed there, it is what tells that computer the offer is this one's and
 * not somebody else's on the network under the same name (security audit 2026-11-27).
 */

interface Found {
  id: string;
  name: string;
  platform: string;
  version: string;
  address: string;
  linked: boolean;
  usedFromAnother: boolean;
}
const OS: Record<string, string> = { darwin: "Mac", linux: "Linux", win32: "Windows" };

/** Add a computer › Nearby. */
export function NearbyLink() {
  const [found, setFound] = useState<Found[] | null>(null);
  const [asked, setAsked] = useState<{ id: string; name: string; code: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    const look = () => void call<{ found: Found[] }>("/api/computers/nearby").then((r) => !gone && setFound(r.found), () => !gone && setFound((f) => f ?? []));
    look();
    const t = setInterval(look, 4000);
    return () => ((gone = true), clearInterval(t));
  }, []);
  const link = async (f: Found) => {
    setBusy(f.id);
    setError("");
    try {
      const r = await call<{ name: string; code: string; error?: string }>("/api/computers/nearby/link", { method: "POST", body: JSON.stringify({ id: f.id }) });
      setAsked({ id: f.id, name: r.name, code: r.code });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const done = found?.find((f) => f.id === asked?.id)?.linked;
  return (
    <div className="computers-add-body nearby">
      {asked && !done ? (
        <div className="nearby-asked">
          <p className="small">
            On <b>{asked.name}</b>, type this code and press <b>Allow</b>:
          </p>
          <div className="nearby-check" aria-label={`Code ${asked.code.split("").join(" ")}`}>
            {asked.code.slice(0, 4)} {asked.code.slice(4)}
          </div>
          <p className="muted small">Waiting for {asked.name}… The offer lasts ten minutes.</p>
        </div>
      ) : (
        <>
          <p className="muted small">Any computer with Friday open on this Wi-Fi shows up here. Link it, then type the code on it.</p>
          <ul className="nearby-list">
            {found === null && <li className="muted small nearby-empty"><span className="nearby-pulse" aria-hidden />Looking…</li>}
            {found?.length === 0 && <li className="muted small nearby-empty"><span className="nearby-pulse" aria-hidden />Looking… Open Friday on the other computer.</li>}
            {found?.map((f) => (
              <li key={f.id}>
                <Icon name="server" size={14} />
                <span className="nearby-name">{f.name}</span>
                <span className="muted small">{[OS[f.platform] ?? f.platform, f.version && `Friday ${f.version}`].filter(Boolean).join(" · ")}</span>
                {f.linked ? (
                  <span className="nearby-done small">Linked</span>
                ) : (
                  <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void link(f)} title={f.usedFromAnother ? "It's linked to another computer now: linking it here moves it" : undefined}>
                    {busy === f.id ? "Asking…" : "Link"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {done && <p className="small computers-said ok">{asked?.name} is linked.</p>}
      {error && <p className="small computers-said bad">{error}</p>}
    </div>
  );
}

/**
 * On the computer being linked: "Maya's MacBook Pro wants to run agents on this computer", the code from that computer's screen
 * to type, Allow or Don't. A wrong code keeps the offer, to try again.
 * Polled while Friday is open here (local edition only); one offer at a time, newest first.
 */
export function LinkOffers() {
  const [offers, setOffers] = useState<{ from: string; name: string; until: number }[]>([]);
  const [code, setCode] = useState("");
  const [wrong, setWrong] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    const look = () => void call<{ offers: typeof offers }>("/api/computers/offers").then((r) => !gone && setOffers((was) => (JSON.stringify(was) === JSON.stringify(r.offers) ? was : r.offers)), () => {});
    // Asked when an offer comes (app-push.ts), not every 3 seconds; as before where nothing tells it.
    const stop = pollWhileShown(look, { every: 3000, on: ["offers"] });
    return () => ((gone = true), stop());
  }, []);
  const o = offers[0];
  const ref = useRef<HTMLDivElement>(null);
  const answer = async (allow: boolean) => {
    if (!o) return;
    setBusy(true);
    setWrong("");
    let stays = false;
    try {
      const r = await call<{ hub?: { connected?: boolean; name?: string } | null; error?: string }>(`/api/computers/offers/${o.from}`, { method: "POST", body: JSON.stringify({ allow, ...(allow ? { code } : {}) }) });
      setSaid(allow ? (r.error ? r.error : `Linked to ${r.hub?.name || o.name}. Its agents can run here now.`) : "");
    } catch (e) {
      // A code that doesn't match: the offer stays, to type it again. Anything else (it ran out) ends it.
      stays = /doesn't match/.test((e as Error).message);
      if (stays) setWrong((e as Error).message);
      else setSaid((e as Error).message);
    } finally {
      setBusy(false);
      if (!stays) {
        setCode("");
        setOffers((l) => l.slice(1));
      }
    }
  };
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 6000);
    return () => clearTimeout(t);
  }, [said]);
  const ready = code.replace(/[^A-Z0-9]/gi, "").length >= 8;
  if (!o) return said ? <div className="nearby-toast small">{said}</div> : null;
  return (
    <div className="overlay nearby-over">
      <div ref={ref} className="modal nearby-offer" role="alertdialog" aria-modal="true" aria-label={`${o.name} wants to link`}>
        <h2>Link to {o.name}?</h2>
        <p className="muted small">
          {o.name} wants to run agents on this computer, with your coding tools here. Type the code it is showing:
        </p>
        <input
          className="input nearby-code"
          autoFocus
          value={code}
          maxLength={12}
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="Code"
          aria-label={`The code ${o.name} is showing`}
          aria-invalid={!!wrong}
          onChange={(e) => (setCode(e.target.value.toUpperCase()), setWrong(""))}
          onKeyDown={(e) => e.key === "Enter" && ready && !busy && void answer(true)}
        />
        {wrong && <p className="small computers-said bad">{wrong}</p>}
        <p className="muted small">Only if you started this on {o.name}. You can remove it any time in Settings › Other computers.</p>
        <div className="nearby-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => void answer(false)}>
            Don't allow
          </button>
          <button type="button" className="btn small primary" disabled={busy || !ready} onClick={() => void answer(true)}>
            {busy ? "Linking…" : "Allow"}
          </button>
        </div>
      </div>
    </div>
  );
}
