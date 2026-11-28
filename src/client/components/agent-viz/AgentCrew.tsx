// Agent Crew (affectUI Pro, rebuilt by hand from its public preview; SPEC agent-crew): a lead and the agents under it as one live
// tree of cards. Each card says what the agent does now, how full its context is when that's known, its tools and the last thing it
// was handed; a hand-off runs as a light down the rounded connector and lights the card it reaches from the edge it came in by.
// A card opens its details below it, with the actions its place offers. Narrower than the tree, it falls back to a list: each
// agent indented under the one that leads it, on the same elbows the grandchildren use.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DropdownMenu } from "../affect/dropdown-menu";
import { Popover } from "../affect/popover";
import { Shine } from "../../shine.js";
import { PixelMark, Tile, ToolRow, VizChip, statusWord, tokensShort, useReducedMotion, type VizColor, type VizStatus, type VizTool } from "./viz-parts.js";
import "./agent-viz.css";

export interface CrewAgent {
  id: string;
  name: string;
  /** Its model or kind, under the name: "Claude Opus", "Explore". */
  model?: string;
  status: VizStatus;
  /** What it is doing right now, or what it came to. */
  doing: string;
  /** How full its context is, when its tool says. */
  context?: { used: number; max: number };
  tools?: VizTool[];
  /** The last thing it was handed: by whom, what, and when (a new `at` runs the light to it). */
  handed?: { from: string; text: string; at: number };
  color: VizColor;
  /** Its own face (a Captain's mascot, a coding tool's logo); else its pixel mark. */
  avatar?: ReactNode;
  children?: CrewAgent[];
  /** What its details offer: open its thread, go to where it was sent. */
  actions?: { label: string; run: () => void }[];
  /** More facts for its details: "Started 4m ago", "3 of 5". */
  facts?: { label: string; value: string }[];
}

export interface CrewProject {
  id: string;
  name: string;
  working: number;
}

export interface AgentCrewProps {
  lead: CrewAgent;
  /** The switcher's title; with `projects`, it swaps between them. */
  title: string;
  titleIcon?: ReactNode;
  projects?: CrewProject[];
  onProject?: (id: string) => void;
  /** Its words for the statuses where they differ ("Running" for a thread). */
  words?: Partial<Record<VizStatus, string>>;
  label?: string;
  className?: string;
  /** No header of its own: where the card around it already says what it is. */
  bare?: boolean;
}

type Edge = { from: string; to: string; d: string; color: VizColor; dot: [number, number] };

const all = (a: CrewAgent): CrewAgent[] => [a, ...(a.children ?? []).flatMap(all)];
const FOLDER = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.7l1.5 1.5h4.8c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);
const CHEVRON = (
  <svg className="viz-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3.5 4.75L6 7.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const HAND_ARROW = (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 2v3.5c0 1 .7 1.8 1.7 1.8H10M7.6 4.9L10 7.3 7.6 9.7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AgentCrew({ lead, title, titleIcon, projects, onProject, words, label, className = "", bare }: AgentCrewProps) {
  const tree = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [narrow, setNarrow] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const still = useReducedMotion();
  const agents = useMemo(() => all(lead), [lead]);
  const kids = lead.children ?? [];
  const working = agents.filter((a) => a.status === "working").length;

  // A hand-off: an agent whose `handed.at` moved on (or one that just arrived) gets the light down its connector, then its glow.
  const seen = useRef<Map<string, number> | null>(null);
  const [lit, setLit] = useState<Record<string, number>>({});
  useEffect(() => {
    const was = seen.current;
    const next = new Map(agents.map((a) => [a.id, a.handed?.at ?? 0]));
    seen.current = next;
    if (!was || still) return;
    const fresh = agents.filter((a) => a.id !== lead.id && (!was.has(a.id) || (a.handed?.at ?? 0) > (was.get(a.id) ?? 0)));
    if (fresh.length) setLit((l) => ({ ...l, ...Object.fromEntries(fresh.map((a) => [a.id, Date.now()])) }));
  }, [agents, lead.id, still]);

  // Wide enough for the lead over a row of its agents (236 each, 8 apart), or the list.
  useLayoutEffect(() => {
    const el = tree.current;
    if (!el) return;
    const fit = () => setNarrow(el.clientWidth < Math.max(1, kids.length) * 244 - 8);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [kids.length]);

  // The connectors, read off where the cards are: the lead's trunk down to a bus and into each column; an elbow from a card's
  // foot into each agent indented under it.
  useLayoutEffect(() => {
    const el = tree.current;
    if (!el) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const at = (id: string) => {
        const r = cards.current.get(id)?.getBoundingClientRect();
        return r ? { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top, cx: r.left - box.left + r.width / 2, cy: r.top - box.top + r.height / 2 } : null;
      };
      const out: Edge[] = [];
      const R = 8;
      const elbow = (p: CrewAgent, c: CrewAgent) => {
        const a = at(p.id);
        const b = at(c.id);
        if (!a || !b) return;
        const x = a.l + 20;
        out.push({ from: p.id, to: c.id, color: p.color, dot: [x, a.b], d: `M${x} ${a.b} V${b.cy - R} Q${x} ${b.cy} ${x + R} ${b.cy} H${b.l}` });
      };
      const walk = (p: CrewAgent, depth: number) => {
        for (const c of p.children ?? []) {
          if (depth === 0 && !narrow) {
            const a = at(p.id);
            const b = at(c.id);
            if (a && b) {
              const bus = a.b + (b.t - a.b) / 2;
              const dx = b.cx - a.cx;
              const r = Math.min(R, Math.abs(dx) / 2, (b.t - bus) / 1);
              const d = Math.abs(dx) < 1 ? `M${a.cx} ${a.b} V${b.t}` : `M${a.cx} ${a.b} V${bus - r} Q${a.cx} ${bus} ${a.cx + Math.sign(dx) * r} ${bus} H${b.cx - Math.sign(dx) * r} Q${b.cx} ${bus} ${b.cx} ${bus + r} V${b.t}`;
              out.push({ from: p.id, to: c.id, color: p.color, dot: [a.cx, a.b], d });
            }
          } else elbow(p, c);
          walk(c, depth + 1);
        }
      };
      walk(lead, 0);
      setEdges(out);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    for (const c of cards.current.values()) ro.observe(c);
    return () => ro.disconnect();
  }, [lead, narrow]);

  const ref = (id: string) => (n: HTMLElement | null) => void (n ? cards.current.set(id, n) : cards.current.delete(id));
  const card = (a: CrewAgent, kind: "lead" | "child" | "sub") => (
    <CrewCard key={a.id} a={a} kind={kind} words={words} lit={lit[a.id]} from={narrow || kind === "sub" ? "left" : "top"} open={open === a.id} onOpen={() => setOpen(open === a.id ? null : a.id)} onClose={() => setOpen(null)} cardRef={ref(a.id)} />
  );
  const sub = (a: CrewAgent): ReactNode =>
    a.children?.length ? (
      <div className="viz-crew-sub" role="group">
        {a.children.map((g) => (
          <div key={g.id} className="viz-crew-item" role="treeitem" aria-selected={false}>
            {card(g, "sub")}
            {sub(g)}
          </div>
        ))}
      </div>
    ) : null;

  const dots = new Map<string, Edge>();
  for (const e of edges) dots.set(`${e.dot[0]}:${e.dot[1]}`, e);
  return (
    <section className={`viz viz-crew ${className}`} aria-label={label ?? `${title}: ${agents.length} agents`}>
      {!bare && (
        <header className="viz-crew-head">
          {projects && projects.length > 1 && onProject ? (
            <DropdownMenu
              title="Switch"
              items={projects.map((p) => ({ label: p.name, description: p.working ? `${p.working} working` : "Quiet", checked: p.name === title, onSelect: () => onProject(p.id) }))}
              trigger={({ triggerProps, open: on }) => (
                <button type="button" className="viz-switch" data-open={on || undefined} {...triggerProps}>
                  {titleIcon ?? FOLDER}
                  <span className="viz-switch-t">{title}</span>
                  {CHEVRON}
                </button>
              )}
            />
          ) : (
            <span className="viz-switch static">
              {titleIcon ?? FOLDER}
              <span className="viz-switch-t">{title}</span>
            </span>
          )}
          <span className="viz-crew-meta">
            {working > 0 && <span className="on">{working} working</span>}
            <span>
              {agents.length} agent{agents.length === 1 ? "" : "s"}
            </span>
          </span>
        </header>
      )}
      <div className="viz-crew-tree" data-narrow={narrow || undefined} ref={tree} role="tree" aria-label={title}>
        <svg className="viz-wires" width={size.w} height={size.h} aria-hidden="true">
          {edges.map((e) => (
            <path key={`${e.from}>${e.to}`} className="viz-wire" data-c={e.color} d={e.d} />
          ))}
          {edges.map((e) =>
            lit[e.to] ? <path key={`${e.to}@${lit[e.to]}`} className="viz-light" data-c={e.color} d={e.d} pathLength={100} /> : null,
          )}
          {[...dots.values()].map((e) => (
            <circle key={`${e.dot[0]}:${e.dot[1]}`} className="viz-node" data-c={e.color} cx={e.dot[0]} cy={e.dot[1]} r={3} />
          ))}
        </svg>
        <div className="viz-crew-item lead" role="treeitem" aria-selected={false} aria-expanded={kids.length ? true : undefined}>
          {card(lead, "lead")}
          {kids.length > 0 && (
            <div className={narrow ? "viz-crew-sub" : "viz-crew-row"} role="group">
              {kids.map((c) => (
                <div key={c.id} className="viz-crew-item col" role="treeitem" aria-selected={false}>
                  {card(c, narrow ? "sub" : "child")}
                  {sub(c)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CrewCard({ a, kind, words, lit, from, open, onOpen, onClose, cardRef }: { a: CrewAgent; kind: "lead" | "child" | "sub"; words?: Partial<Record<VizStatus, string>>; lit?: number; from: "top" | "left"; open: boolean; onOpen: () => void; onClose: () => void; cardRef: (n: HTMLElement | null) => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const small = kind === "sub" && !a.children?.length && !a.tools?.length && !a.model;
  const pct = a.context ? Math.min(100, Math.max(1.5, (a.context.used / Math.max(1, a.context.max)) * 100)) : 0;
  return (
    <>
      <button
        type="button"
        ref={(n) => {
          anchor.current = n;
          cardRef(n);
        }}
        className={`viz-crew-card ${kind}${small ? " small" : ""}`}
        data-c={a.color}
        data-s={a.status}
        aria-expanded={open}
        aria-label={`${a.name}: ${statusWord(a.status, words)}. ${a.doing}`}
        onClick={onOpen}
      >
        {/* The Gradient Floor: the agent's colour full at the edge the light came in by, rising across while it fades. */}
        {lit ? <span key={lit} className="viz-floor" data-from={from} aria-hidden="true" /> : null}
        <span className="viz-crew-r1">
          <Tile size={small ? 18 : 22} className="viz-av">
            {a.avatar ?? <PixelMark seed={a.name} color={a.color} working={a.status === "working"} />}
          </Tile>
          <span className="viz-nm">
            <span className="viz-name">{a.name}</span>
            {a.model && a.model !== a.name && <span className="viz-model">{a.model}</span>}
          </span>
          <VizChip status={a.status} words={words} bare={small} />
        </span>
        {a.doing && (
          <Shine on={a.status === "working"} className="viz-crew-doing">
            {a.doing}
          </Shine>
        )}
        {a.context && (
          <span className="viz-ctx">
            <span className="viz-ctx-track">
              <i style={{ width: `${pct}%` } as CSSProperties} />
            </span>
            <span className="viz-ctx-n">
              {tokensShort(a.context.used)} / {tokensShort(a.context.max)}
            </span>
          </span>
        )}
        {kind !== "sub" && (a.tools?.length || a.handed) ? (
          <span className="viz-crew-foot">
            <ToolRow tools={a.tools ?? []} />
            {a.handed && (
              <span className="viz-handed" title={`${a.handed.from}: ${a.handed.text}`}>
                {HAND_ARROW}
                <b>{a.handed.from}</b>
                <span>{a.handed.text}</span>
              </span>
            )}
          </span>
        ) : null}
      </button>
      {open && (
        <Popover open onClose={onClose} anchor={anchor} side="bottom" align="start" width={280} unstyled className="viz viz-pop" aria-label={a.name}>
          <CrewDetails a={a} words={words} onClose={onClose} />
        </Popover>
      )}
    </>
  );
}

function CrewDetails({ a, words, onClose }: { a: CrewAgent; words?: Partial<Record<VizStatus, string>>; onClose: () => void }) {
  const facts = [...(a.facts ?? []), ...(a.context ? [{ label: "Context", value: `${tokensShort(a.context.used)} / ${tokensShort(a.context.max)}` }] : [])];
  return (
    <div className="viz-pop-in">
      <div className="viz-pop-head">
        <Tile size={22}>{a.avatar ?? <PixelMark seed={a.name} color={a.color} working={a.status === "working"} />}</Tile>
        <span className="viz-nm">
          <span className="viz-name">{a.name}</span>
          <span className="viz-model">{[a.model, statusWord(a.status, words)].filter(Boolean).join(" · ")}</span>
        </span>
        <button type="button" className="viz-x" aria-label="Close" onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="viz-pop-well">
        <p>{a.doing}</p>
        {a.handed && (
          <p className="viz-pop-handed">
            {HAND_ARROW}
            <b>{a.handed.from}</b> {a.handed.text}
          </p>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="viz-facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {a.tools && a.tools.length > 0 && (
        <>
          <span className="viz-eyebrow">Tools</span>
          <ul className="viz-pop-tools">
            {a.tools.map((t) => (
              <li key={t.id}>
                <Tile size={16}>{t.mark}</Tile>
                {t.label}
              </li>
            ))}
          </ul>
        </>
      )}
      {a.actions && a.actions.length > 0 && (
        <div className="viz-pop-acts">
          {a.actions.map((x, i) => (
            <button key={x.label} type="button" className={i === a.actions!.length - 1 ? "viz-btn primary" : "viz-btn"} onClick={() => (onClose(), x.run())}>
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
