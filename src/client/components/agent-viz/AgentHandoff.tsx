// Agent Handoff (affectUI Pro, rebuilt by hand from its public preview; measured 2026-11-27 like the others): a task relayed agent to
// agent. The agents across the top, each with what it does and what it is on; under each pair the hand-ons between them, every one
// a card of what went along and, opened, each thing carried and each thing lost on the way (a lost one opens to say why). At a
// hand-on a light runs down the line into the column, the card drops in, and the light runs on up to the agent it went to.
// Agent-to-agent talk is the product's main selling point (Arun): nothing here pauses or hides it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Shine } from "../../shine.js";
import { PixelMark, Tile, VizSpinner, statusWord, usd, useReducedMotion, type VizColor, type VizStatus, type VizTool } from "./viz-parts.js";
import "./agent-viz.css";

export interface HandoffAgent {
  id: string;
  name: string;
  model?: string;
  avatar?: ReactNode;
  color: VizColor;
  status: VizStatus;
  cost?: number;
  /** What it does, in a sentence. */
  role: string;
  /** What it is on now, and what it is doing with it. */
  now?: { title: string; doing: string; tool?: VizTool };
  /** What waits for it, and how many more. */
  next?: { title: string; more: number; tool?: VizTool };
}

export interface HandoffThing {
  label: string;
  /** "file", "link", "note", "check": its 12px mark. */
  kind?: "file" | "link" | "note" | "check";
}

export interface HandoffItem {
  id: string;
  title: string;
  icon?: ReactNode;
  /** What went along, in a line. */
  summary: string;
  /** Where it stands: with the next agent (live), through, sent back, stuck, or waiting its turn. */
  state: { kind: "with" | "good" | "back" | "stuck" | "next"; text: string };
  carried: HandoffThing[];
  lost: { label: string; why: string }[];
}

export interface HandoffRelay {
  from: string;
  to: string;
  items: HandoffItem[];
}

export interface AgentHandoffProps {
  agents: HandoffAgent[];
  relays: HandoffRelay[];
  words?: Partial<Record<VizStatus, string>>;
  label?: string;
  className?: string;
  /** How many hand-on cards a column shows before it fades out at the bottom. */
  rows?: number;
}

const THING: Record<NonNullable<HandoffThing["kind"]>, ReactNode> = {
  file: <path d="M7.5 1.5H3.8c-.6 0-1 .4-1 1v7c0 .6.4 1 1 1h4.4c.6 0 1-.4 1-1V3.5zM7.5 1.5v2h1.7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
  link: <path d="M5 7l2-2M4.2 5.8l-.9.9a1.6 1.6 0 0 0 2.3 2.3l.9-.9M7.8 6.2l.9-.9a1.6 1.6 0 0 0-2.3-2.3l-.9.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
  note: <path d="M2.5 6.2l2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />,
  check: <path d="M6 1.5l3.6 1.4v2.7c0 2.3-1.6 3.9-3.6 4.9-2-1-3.6-2.6-3.6-4.9V2.9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
};
const LOST = <path d="M3.2 3.2l5.6 5.6M10 6A4 4 0 1 1 2 6a4 4 0 0 1 8 0z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />;
const ARROW = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 6h7M7 3.5L9.5 6 7 8.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type Wire = { id: string; d: string; c: VizColor; dir: "in" | "out"; relay: number };

export function AgentHandoff({ agents, relays, words, label, className = "", rows = 2 }: AgentHandoffProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const agentEls = useRef(new Map<string, HTMLElement>());
  const relayEls = useRef(new Map<number, HTMLElement>());
  const [narrow, setNarrow] = useState(false);
  const [geo, setGeo] = useState<{ w: number; h: number; wires: Wire[]; dots: [number, number, VizColor][] }>({ w: 0, h: 0, wires: [], dots: [] });
  const [open, setOpen] = useState<string | null>(null);
  const still = useReducedMotion();
  const byId = new Map(agents.map((a) => [a.id, a]));

  // A new hand-on: the light down into its column, then (after the card has dropped in) up to the agent it went to.
  const seen = useRef<Set<string> | null>(null);
  const [lit, setLit] = useState<Record<number, number>>({});
  useEffect(() => {
    const ids = new Set(relays.flatMap((r, i) => r.items.map((x) => `${i}:${x.id}`)));
    const was = seen.current;
    seen.current = ids;
    if (!was || still) return;
    const fresh = [...new Set([...ids].filter((k) => !was.has(k)).map((k) => Number(k.split(":")[0])))];
    if (fresh.length) setLit((l) => ({ ...l, ...Object.fromEntries(fresh.map((i) => [i, Date.now()])) }));
  }, [relays, still]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setNarrow(el.clientWidth < agents.length * 2 * 112);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [agents.length]);

  // Each agent's foot to the top of the columns either side of it: into the one it hands to, out of the one handed to it.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const wires: Wire[] = [];
      const dots: [number, number, VizColor][] = [];
      const R = 8;
      relays.forEach((r, i) => {
        const col = relayEls.current.get(i)?.getBoundingClientRect();
        const a = agentEls.current.get(r.from)?.getBoundingClientRect();
        const b = agentEls.current.get(r.to)?.getBoundingClientRect();
        if (!col || !a || !b) return;
        const top = col.top - box.top;
        const cx = col.left - box.left + col.width / 2;
        // The relay's lines are one colour, the live one: the light that runs them is the hand-on itself.
        const from: VizColor = "blue";
        const to: VizColor = "blue";
        if (narrow) {
          const ax = a.left - box.left + a.width / 2;
          wires.push({ id: `${i}in`, relay: i, c: from, dir: "in", d: `M${ax} ${a.bottom - box.top} V${top}` });
          wires.push({ id: `${i}out`, relay: i, c: to, dir: "out", d: `M${ax} ${col.bottom - box.top} V${b.top - box.top}` });
          dots.push([ax, a.bottom - box.top, from], [ax, top, from]);
          return;
        }
        const bend = (ax: number, ay: number, x: number) => {
          const mid = ay + (top - ay) / 2;
          const dx = x - ax;
          const r2 = Math.min(R, Math.abs(dx) / 2);
          return Math.abs(dx) < 1 ? `M${ax} ${ay} V${top}` : `M${ax} ${ay} V${mid - r2} Q${ax} ${mid} ${ax + Math.sign(dx) * r2} ${mid} H${x - Math.sign(dx) * r2} Q${x} ${mid} ${x} ${mid + r2} V${top}`;
        };
        const ax = a.left - box.left + a.width / 2;
        const bx = b.left - box.left + b.width / 2;
        const ay = a.bottom - box.top;
        const by = b.bottom - box.top;
        wires.push({ id: `${i}in`, relay: i, c: from, dir: "in", d: bend(ax, ay, cx - 14) });
        // Drawn from the agent down, so the light running up it plays the path backwards.
        wires.push({ id: `${i}out`, relay: i, c: to, dir: "out", d: bend(bx, by, cx + 14) });
        dots.push([ax, ay, from], [bx, by, to], [cx - 14, top, from], [cx + 14, top, to]);
      });
      setGeo({ w: el.scrollWidth, h: el.scrollHeight, wires, dots });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [agents, relays, narrow]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = agents.length;
  const seenDots = new Set<string>();
  return (
    <section className={`viz viz-hand ${className}`} aria-label={label ?? "Hand-ons between the agents"}>
      <div className="viz-hand-grid" data-narrow={narrow || undefined} ref={wrap} style={{ "--n": n } as CSSProperties}>
        <svg className="viz-wires" width={geo.w} height={geo.h} aria-hidden="true">
          {geo.wires.map((w) => (
            <path key={w.id} className="viz-wire" data-c={w.c} d={w.d} />
          ))}
          {geo.wires.map((w) =>
            lit[w.relay] ? <path key={`${w.id}@${lit[w.relay]}`} className={`viz-light ${w.dir}`} data-c={w.c} d={w.d} pathLength={100} /> : null,
          )}
          {geo.dots.map(([x, y, c]) => {
            const k = `${Math.round(x)}:${Math.round(y)}`;
            if (seenDots.has(k)) return null;
            seenDots.add(k);
            return <circle key={k} className="viz-node" data-c={c} cx={x} cy={y} r={3} />;
          })}
        </svg>
        {agents.map((a, i) => (
          <article
            key={a.id}
            ref={(el) => void (el ? agentEls.current.set(a.id, el) : agentEls.current.delete(a.id))}
            className="viz-hand-agent"
            data-c={a.color}
            data-s={a.status}
            style={narrow ? ({ order: i * 2 } as CSSProperties) : ({ gridColumn: `${i * 2 + 1} / span 2`, gridRow: 1 } as CSSProperties)}
            aria-label={`${a.name}: ${statusWord(a.status, words)}`}
          >
            <span className="viz-hand-r1">
              <Tile size={26}>{a.avatar ?? <PixelMark seed={a.name} color={a.color} working={a.status === "working"} />}</Tile>
              <span className="viz-nm">
                <span className="viz-name">{a.name}</span>
                {a.model && <span className="viz-model">{a.model}</span>}
              </span>
              {a.cost != null && (
                <Shine on={a.status === "working"} className="viz-hand-cost">
                  {usd(a.cost)}
                </Shine>
              )}
              <span className="viz-hand-chip" data-s={a.status}>
                {a.status === "working" && <VizSpinner size={12} />}
                <span key={a.status} className="viz-swap">
                  {statusWord(a.status, words)}
                </span>
              </span>
            </span>
            <span className="viz-hand-role">{a.role}</span>
            <span className="viz-hand-now">
              {a.now ? (
                <span key={`now:${a.now.title}`} className="viz-swap row">
                  {a.now.tool && <Tile size={16}>{a.now.tool.mark}</Tile>}
                  <b>{a.now.title}</b>
                  <Shine on={a.status === "working"} className="viz-hand-doing">
                    {a.now.doing}
                  </Shine>
                </span>
              ) : a.next ? (
                <span key={`next:${a.next.title}`} className="viz-swap row">
                  <span className="viz-hand-faint">Up next</span>
                  {a.next.tool && <Tile size={16}>{a.next.tool.mark}</Tile>}
                  <b>{a.next.title}</b>
                  {a.next.more > 0 && <span className="viz-hand-more">+{a.next.more}</span>}
                </span>
              ) : (
                <span className="viz-hand-faint">Ready for a task</span>
              )}
            </span>
          </article>
        ))}
        {relays.map((r, i) => {
          const a = byId.get(r.from);
          const b = byId.get(r.to);
          const fromAt = agents.findIndex((x) => x.id === r.from);
          return (
            <section
              key={`${r.from}>${r.to}`}
              ref={(el) => void (el ? relayEls.current.set(i, el) : relayEls.current.delete(i))}
              className="viz-hand-col"
              data-c={a?.color}
              data-rows={rows}
              style={narrow ? ({ order: fromAt * 2 + 1 } as CSSProperties) : ({ gridColumn: `${fromAt * 2 + 2} / span 2`, gridRow: 2 } as CSSProperties)}
              aria-label={`From ${a?.name ?? "?"} to ${b?.name ?? "?"}: ${r.items.length}`}
            >
              <header className="viz-hand-colh">
                <span className="viz-hand-pair">
                  {a && <Tile size={16}>{a.avatar ?? <PixelMark seed={a.name} color={a.color} />}</Tile>}
                  <span>{a?.name}</span>
                  {ARROW}
                  {b && <Tile size={16}>{b.avatar ?? <PixelMark seed={b.name} color={b.color} />}</Tile>}
                  <span>{b?.name}</span>
                </span>
                <span className="viz-hand-n">{r.items.length}</span>
              </header>
              <ul className="viz-hand-list" data-fade={r.items.length > rows || undefined}>
                {r.items.map((x) => (
                  <HandCard key={x.id} x={x} open={open === `${i}:${x.id}`} onToggle={() => setOpen(open === `${i}:${x.id}` ? null : `${i}:${x.id}`)} />
                ))}
                {!r.items.length && <li className="viz-hand-none">Nothing handed on yet</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function HandCard({ x, open, onToggle }: { x: HandoffItem; open: boolean; onToggle: () => void }) {
  const [why, setWhy] = useState<string | null>(null);
  return (
    <li className="viz-hand-card" data-open={open || undefined}>
      <button type="button" className="viz-hand-cardb" aria-expanded={open} onClick={onToggle}>
        <span className="viz-hand-t">
          {x.icon && <span className="viz-hand-ic">{x.icon}</span>}
          <span>{x.title}</span>
        </span>
        <span className="viz-hand-sum">{x.summary}</span>
        <span className="viz-hand-state" data-k={x.state.kind}>
          {x.state.kind === "with" ? <VizSpinner size={12} /> : <i aria-hidden="true" />}
          {x.state.text}
        </span>
      </button>
      {open && (
        <ul className="viz-hand-things">
          {x.carried.map((t, k) => (
            <li key={`c${k}`}>
              <span className="viz-hand-thing">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  {THING[t.kind ?? "note"]}
                </svg>
                <span>{t.label}</span>
              </span>
            </li>
          ))}
          {x.lost.map((t, k) => (
            <li key={`l${k}`}>
              <button type="button" className="viz-hand-thing lost" aria-expanded={why === t.label} onClick={() => setWhy(why === t.label ? null : t.label)} title="Lost on the way: why">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  {LOST}
                </svg>
                <span>{t.label}</span>
              </button>
              {why === t.label && <p className="viz-hand-why">{t.why}</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
