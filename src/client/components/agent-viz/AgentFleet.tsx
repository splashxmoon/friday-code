// Agent Fleet (affectUI Pro, rebuilt by hand from its public preview; SPEC agent-fleet): several agents side by side, each card
// summing up the agents under it (who needs you, how many run, what failed, what it has cost), and one open: a press opens its
// tree to the right while the one open before folds back into its card. Narrower than both columns, the tree opens under its card.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Shine } from "../../shine.js";
import { PixelMark, Tile, ToolRow, VizChip, tookOf, usd, useReducedMotion, type VizColor, type VizStatus, type VizTool } from "./viz-parts.js";
import "./agent-viz.css";

export interface FleetSub {
  id: string;
  name: string;
  model?: string;
  status: VizStatus;
  task: string;
  tools?: VizTool[];
  cost?: number;
  /** How long it has worked. */
  ms?: number;
  /** "4 tasks": what it has on, when that's known. */
  count?: string;
  avatar?: ReactNode;
  color: VizColor;
  /** Its one action where it waits on you: Answer, Resolve, Open. */
  action?: { label: string; run: () => void };
  onOpen?: () => void;
  children?: FleetSub[];
}

export interface FleetAgent {
  id: string;
  name: string;
  model?: string;
  status: VizStatus;
  task: string;
  tools?: VizTool[];
  cost?: number;
  ms?: number;
  avatar?: ReactNode;
  color: VizColor;
  subs: FleetSub[];
}

export interface AgentFleetProps {
  agents: FleetAgent[];
  title?: string;
  /** Its words for the statuses ("Running" for a thread at work). */
  words?: Partial<Record<VizStatus, string>>;
  /** Its word for the agents under one ("threads"). */
  subWord?: [string, string];
  defaultOpen?: string;
  /** Opens this one when it changes, as a press would (the last one folding back first). */
  show?: string;
  label?: string;
  className?: string;
}

const SPARK = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.2l1.3 3.6c.2.6.6 1 1.2 1.2l3.3 1-3.3 1c-.6.2-1 .6-1.2 1.2L8 13.8l-1.3-3.6c-.2-.6-.6-1-1.2-1.2L2.2 8l3.3-1c.6-.2 1-.6 1.2-1.2z" fill="var(--live)" />
  </svg>
);
const SUM_ICON: Record<"needs" | "run" | "failed" | "done", ReactNode> = {
  needs: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5 2.8V5l1.4.9" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
  run: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5 2.8V5l1.4.9" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
  failed: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill="currentColor" fillOpacity=".7" />
    </svg>
  ),
  done: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill="currentColor" fillOpacity=".7" />
    </svg>
  ),
};

const flat = (s: FleetSub): FleetSub[] => [s, ...(s.children ?? []).flatMap(flat)];

/** "1 needs you", "2/4 running", "1 failed", "All 3 done": the most pressing thing about the agents under one, said once. */
export function fleetSummary(subs: FleetSub[], word: [string, string] = ["sub-agent", "sub-agents"]): { icon: keyof typeof SUM_ICON; text: string } | null {
  const all = subs.flatMap(flat);
  if (!all.length) return null;
  const n = (s: VizStatus) => all.filter((x) => x.status === s).length;
  if (n("needs")) return { icon: "needs", text: `${n("needs")} need${n("needs") === 1 ? "s" : ""} you` };
  if (n("failed")) return { icon: "failed", text: `${n("failed")} failed` };
  if (n("working")) return { icon: "run", text: `${n("working")}/${all.length} running` };
  if (n("done") === all.length) return { icon: "done", text: all.length === 1 ? "Done" : `All ${all.length} done` };
  return { icon: "done", text: `${all.length} ${all.length === 1 ? word[0] : word[1]}` };
}

export function AgentFleet({ agents, title = "Fleet", words, subWord = ["sub-agent", "sub-agents"], defaultOpen, show, label, className = "" }: AgentFleetProps) {
  const [open, setOpen] = useState<string | null>(defaultOpen ?? agents[0]?.id ?? null);
  // The tree that was open, folding back before the next one opens.
  const [leaving, setLeaving] = useState<FleetAgent | null>(null);
  const still = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const subEls = useRef(new Map<string, HTMLElement>());
  const treeEl = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [geo, setGeo] = useState<{ w: number; h: number; shift: number; wires: { id: string; d: string; c: VizColor }[]; dots: [number, number][] }>({ w: 0, h: 0, shift: 0, wires: [], dots: [] });
  const current = agents.find((a) => a.id === open) ?? null;
  useEffect(() => {
    if (open && !agents.some((a) => a.id === open)) setOpen(agents[0]?.id ?? null);
  }, [agents, open]);

  const pick = (id: string) => {
    if (id === open) return;
    const was = current;
    if (was && !still && !narrow) {
      setLeaving(was);
      setTimeout(() => setLeaving(null), 240);
    }
    setOpen(id);
  };

  useEffect(() => {
    if (show) pick(show);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setNarrow(el.clientWidth < 288 + 56 + 272);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The connectors from the open card's right edge into each card of its tree, and the tree centred on its card.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el || !current || leaving) {
      setGeo((g) => ({ ...g, wires: [], dots: [] }));
      return;
    }
    const draw = () => {
      // Read off the layout, not the screen: the cards rise in and the tree glides, and a box read mid-way would aim the wires
      // where a card was, not where it lands.
      const box = (n: HTMLElement) => {
        let l = 0;
        let t = 0;
        for (let x: HTMLElement | null = n; x && x !== el; x = x.offsetParent as HTMLElement | null) (l += x.offsetLeft), (t += x.offsetTop);
        return { l, t, w: n.offsetWidth, h: n.offsetHeight };
      };
      const rel = (n: HTMLElement, dy = 0) => {
        const b = box(n);
        return { l: b.l, r: b.l + b.w, t: b.t + dy, b: b.t + b.h + dy, cy: b.t + b.h / 2 + dy };
      };
      const aEl = cardEls.current.get(current.id);
      if (!aEl) return;
      const A = rel(aEl);
      let shift = 0;
      if (!narrow && treeEl.current) {
        const h = treeEl.current.offsetHeight;
        shift = Math.max(0, Math.min(A.cy - h / 2, el.scrollHeight - h));
      }
      const dy = narrow ? 0 : shift;
      const wires: { id: string; d: string; c: VizColor }[] = [];
      const dots: [number, number][] = [];
      const R = 8;
      const top = current.subs;
      for (const s of top) {
        const r = subEls.current.get(s.id);
        if (!r) continue;
        const B = rel(r, dy);
        const by = B.cy;
        if (narrow) {
          const x = A.l + 20;
          wires.push({ id: s.id, c: "blue", d: `M${x} ${A.b} V${by - R} Q${x} ${by} ${x + R} ${by} H${B.l}` });
          dots.push([x, A.b]);
        } else {
          const mid = A.r + 28;
          const d = by - A.cy;
          const r2 = Math.min(R, Math.abs(d) / 2);
          wires.push({ id: s.id, c: "blue", d: Math.abs(d) < 1 ? `M${A.r} ${A.cy} H${B.l}` : `M${A.r} ${A.cy} H${mid - r2} Q${mid} ${A.cy} ${mid} ${A.cy + Math.sign(d) * r2} V${by - Math.sign(d) * r2} Q${mid} ${by} ${mid + r2} ${by} H${B.l}` });
          dots.push([A.r, A.cy]);
        }
        // Its own agents, indented under it on an elbow.
        const elbows = (p: FleetSub, P: { l: number; b: number }) => {
          for (const c of p.children ?? []) {
            const cr = subEls.current.get(c.id);
            if (!cr) continue;
            const C = rel(cr, dy);
            const cy = C.cy;
            const x = P.l + 20;
            wires.push({ id: c.id, c: "blue", d: `M${x} ${P.b} V${cy - R} Q${x} ${cy} ${x + R} ${cy} H${C.l}` });
            dots.push([x, P.b]);
            elbows(c, { l: C.l, b: C.b });
          }
        };
        elbows(s, { l: B.l, b: B.b });
      }
      setGeo({ w: el.scrollWidth, h: Math.max(el.scrollHeight, 0), shift, wires, dots });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    if (treeEl.current) ro.observe(treeEl.current);
    return () => ro.disconnect();
  }, [current, leaving, narrow, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  const subsAll = agents.flatMap((a) => a.subs.flatMap(flat));
  const running = [...agents, ...subsAll].filter((x) => x.status === "working").length;
  const needs = [...agents, ...subsAll].filter((x) => x.status === "needs").length;
  const cost = agents.reduce((n, a) => n + (a.cost ?? 0), 0);
  const costed = agents.some((a) => a.cost != null);
  const shownTree = leaving ?? current;
  const tree = shownTree ? (
    <div key={shownTree.id} ref={treeEl} className={`viz-fleet-tree${leaving ? " out" : ""}`} role="group" aria-label={`${shownTree.name}'s ${subWord[1]}`} style={narrow ? undefined : ({ transform: `translateY(${geo.shift}px)` } as CSSProperties)}>
      {shownTree.subs.length ? (
        shownTree.subs.map((s, i) => <SubNode key={s.id} s={s} i={i} words={words} refs={subEls.current} />)
      ) : (
        <p className="viz-fleet-none">Nothing under it right now</p>
      )}
    </div>
  ) : null;

  return (
    <section className={`viz viz-fleet ${className}`} aria-label={label ?? title}>
      <header className="viz-fleet-head">
        {SPARK}
        <span className="viz-fleet-title">{title}</span>
        <span className="viz-fleet-meta">
          <span>
            {agents.length} agent{agents.length === 1 ? "" : "s"} / {subsAll.length} {subsAll.length === 1 ? subWord[0] : subWord[1]}
          </span>
          {running > 0 && <span>{running} running</span>}
          {needs > 0 && <span>{needs} need{needs === 1 ? "s" : ""} you</span>}
          {costed && (
            <Shine on={running > 0} className="viz-fleet-cost">
              {usd(cost)}
            </Shine>
          )}
        </span>
      </header>
      <div className="viz-fleet-grid" data-narrow={narrow || undefined} ref={wrap}>
        <svg className="viz-wires" width={geo.w} height={geo.h} aria-hidden="true">
          {geo.wires.map((w) => (
            <path key={`${open}:${w.id}`} className="viz-wire draw" data-c={w.c} d={w.d} pathLength={100} />
          ))}
          {geo.dots.map(([x, y]) => (
            <circle key={`${x}:${y}`} className="viz-node" data-c="blue" cx={x} cy={y} r={3} />
          ))}
        </svg>
        <div className="viz-fleet-col">
          {agents.map((a) => {
            const sum = fleetSummary(a.subs, subWord);
            const on = a.id === open;
            return (
              <div key={a.id} className="viz-fleet-slot">
                <button
                  type="button"
                  ref={(n) => void (n ? cardEls.current.set(a.id, n) : cardEls.current.delete(a.id))}
                  className="viz-fleet-card"
                  data-on={on || undefined}
                  data-c={a.color}
                  aria-expanded={on}
                  onClick={() => pick(a.id)}
                >
                  <span className="viz-fleet-r1">
                    <Tile size={22}>{a.avatar ?? <PixelMark seed={a.name} color={a.color} working={a.status === "working"} />}</Tile>
                    <span className="viz-nm">
                      <span className="viz-name">{a.name}</span>
                      {a.model && <span className="viz-model">{a.model}</span>}
                    </span>
                    <VizChip status={a.status} words={words} />
                  </span>
                  <span className="viz-fleet-r2">
                    <ToolRow tools={a.tools ?? []} stacked />
                    <span className="viz-fleet-task">{a.task}</span>
                  </span>
                  <span className="viz-fleet-r3">
                    {sum && (
                      <span className="viz-fleet-sum" data-k={sum.icon}>
                        {SUM_ICON[sum.icon]}
                        {sum.text}
                      </span>
                    )}
                    <span className="viz-fleet-bill">
                      {a.cost != null && (
                        <Shine on={a.status === "working"} className="viz-fleet-usd">
                          {usd(a.cost)}
                        </Shine>
                      )}
                      {a.ms != null && <span className="viz-fleet-ms">{a.cost != null ? " · " : ""}{tookOf(a.ms)}</span>}
                    </span>
                  </span>
                </button>
                {narrow && on && tree}
              </div>
            );
          })}
        </div>
        {!narrow && <div className="viz-fleet-right">{tree}</div>}
      </div>
    </section>
  );
}

function SubNode({ s, i, words, refs }: { s: FleetSub; i: number; words?: Partial<Record<VizStatus, string>>; refs: Map<string, HTMLElement> }) {
  return (
    <div className="viz-fleet-item" role="treeitem" aria-selected={false} style={{ "--i": i } as CSSProperties}>
      <div ref={(n) => void (n ? refs.set(s.id, n) : refs.delete(s.id))} className="viz-fleet-sub" data-c={s.color} data-s={s.status}>
        <button type="button" className="viz-fleet-subb" onClick={s.onOpen} disabled={!s.onOpen} aria-label={`${s.name}: ${s.task}`} />
        <span className="viz-fleet-r1">
          <Tile size={22}>{s.avatar ?? <PixelMark seed={s.name} color={s.color} working={s.status === "working"} />}</Tile>
          <span className="viz-nm">
            <span className="viz-name">{s.name}</span>
            {s.model && <span className="viz-model">{s.model}</span>}
          </span>
          <VizChip status={s.status} words={words} />
        </span>
        <span className="viz-fleet-r2">
          <ToolRow tools={s.tools ?? []} stacked />
          <span className="viz-fleet-task">{s.task}</span>
        </span>
        <span className="viz-fleet-r3">
          <span className="viz-fleet-bill">
            {s.cost != null && <span className="viz-fleet-usd">{usd(s.cost)}</span>}
            {s.ms != null && <span className="viz-fleet-ms">{s.cost != null ? " · " : ""}{tookOf(s.ms)}</span>}
          </span>
          {s.action ? (
            <button type="button" className="viz-mini" onClick={s.action.run}>
              {s.action.label}
            </button>
          ) : (
            s.count && <span className="viz-fleet-count">{s.count}</span>
          )}
        </span>
      </div>
      {s.children?.length ? (
        <div className="viz-fleet-nest" role="group">
          {s.children.map((c, k) => (
            <SubNode key={c.id} s={c} i={i + k + 1} words={words} refs={refs} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
