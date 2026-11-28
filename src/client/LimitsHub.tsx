import { useEffect, useMemo, useState } from "react";
import type { Limits } from "../runner/limits.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import {
  cyclesOf,
  dailyPeaks,
  forecastOf,
  groupOf,
  idOf,
  isFiveHour,
  isWeekly,
  listPrice,
  fullestOf,
  mostRoom,
  readCosts,
  readHistory,
  saveCost,
  shortName,
  weekGrid,
  windowsOf,
  type Forecast,
  type History,
  type Win,
} from "./limitHistory.js";
import type { Read } from "./toolLimits.js";
import { Skeleton } from "./ui.js";
import { PlugIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Button as KitButton } from "@/components/affect";
import { EmptyState, surface } from "@/components/dass";
import { AccountCardsView } from "./gauge.js";
import { UsageAccounts } from "./usage-accounts.js";
import type { Identity } from "./storage.js";
import "./limits-group.css";

/**
 * The coding tools' limits as one place to plan the day from: each tool's five-hour and weekly windows as rings, the pace
 * they are being used at and where that ends, what the plans cost and whether a smaller one would do, which tool has the
 * most room right now, and a week of five-hour windows. Read from this computer's tools; the history is kept here too.
 */

const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short" });
function until(sec: number, now: number): string {
  const m = Math.max(0, Math.round((sec * 1000 - now) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
/** When a window resets, short, for its row: "in 2h 10m" within the day, else its day and hour ("Mon 9 AM"), as the polish mock says it. */
function resetShort(sec: number, now: number): string {
  if (sec * 1000 - now < 86_400_000) return `in ${until(sec, now)}`;
  const d = new Date(sec * 1000);
  return `${day(sec)} ${d.toLocaleTimeString([], d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" })}`;
}
/** One meaning for every limit, whatever the tool: green with room, yellow from 70%, red from 90%. */
const level = (used: number) => (used >= 90 ? "hot" : used >= 70 ? "warm" : "ok");

/** The plan each tool says it is on. */
function planOf(tool: EngineTool, l: Limits): string | null {
  if (tool === "claude") return l.claudePlan ?? null;
  if (tool === "codex") return l.codex?.plan ?? null;
  if (tool === "cursor") return l.cursor?.plan ?? null;
  if (tool === "copilot") return l.copilot?.plan ?? null;
  return l.tools?.[tool]?.plan ?? null;
}

/** What the pace says, in a line: when it runs out, or where it ends. */
function paceLine(w: Win, f: Forecast | null, now: number): string {
  if (!f) return w.used > 0 ? "Pace shows after a few readings" : "Not used yet";
  if (f.perHour === 0) return "Not moving right now";
  if (f.fullAt) return `At this pace, full by ${new Date(f.fullAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${w.resetsAt ? `, ${until(w.resetsAt, f.fullAt)} before it resets` : ""}`;
  return f.atReset !== null ? `At this pace, ${f.atReset}% when it resets` : `${Math.round(f.perHour)}% an hour`;
}

/** The same, as said in a sentence: "of its 5 hours", "of its week", "of its Gemini 5 hours". */
function ofName(w: Win): string {
  if (isFiveHour(w)) return groupOf(w) ? `${groupOf(w)} 5 hours` : "5 hours";
  const n = shortName(w);
  return n === "Week" || n === "Month" ? n.toLowerCase() : n;
}
const resetWhen = (w: Win) => (w.resetsAt ? (isFiveHour(w) ? clock(w.resetsAt) : `${day(w.resetsAt)} ${clock(w.resetsAt)}`) : "");
/** Where this pace ends on the bar: full before it resets, or where it lands; nothing until there are readings to tell. */
function paceAt(w: Win, f: Forecast | null): number | null {
  if (!f || w.used >= 100) return null;
  const at = f.fullAt ? 100 : f.atReset;
  return at !== null && at > w.used + 1 ? Math.min(100, at) : null;
}

/** One window as a bar on the card: its name, how full, where the pace ends, and how long until it resets. */
function WinBar({ w, history, now, bare }: { w: Win; history: History; now: number; /** The card's only window: the bar alone under its figure. */ bare?: boolean }) {
  const f = forecastOf(w, history[idOf(w)] ?? [], now);
  const tick = paceAt(w, f);
  const used = Math.round(w.used);
  const name = shortName(w);
  const tip = `${name}: ${used}% used${w.resetsAt ? `, resets ${resetWhen(w)} (in ${until(w.resetsAt, now)})` : ""}. ${paceLine(w, f, now)}.`;
  const meter = (
    <span className="lh-meter" role="meter" aria-label={`${name} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-valuetext={tip}>
      <i className={`lh-meter-fill ${level(w.used)}`} style={{ width: `${Math.min(100, w.used)}%` }} />
      {tick !== null && <i className="lh-meter-tick" style={{ left: `${tick}%` }} />}
    </span>
  );
  if (bare) return <div className="lh-wrow bare" title={tip}>{meter}</div>;
  return (
    <li className="lh-wrow" title={tip}>
      <span className="lh-wrow-name">{name}</span>
      {meter}
      <span className={`lh-wrow-n ${level(w.used)}`}>{used}%</span>
      <span className="lh-wrow-in">{w.resetsAt ? resetShort(w.resetsAt, now) : "—"}</span>
    </li>
  );
}

/**
 * A tool, said as one number: what is left of the window it will run out of first, when that resets and where its pace ends,
 * then each of its windows on the same scale (Arun, 2026-11-08: "easy to glance at and fully understand", design C).
 */
function ToolCard({ tool, wins, plan, note, roomy, history, now, cost, onCost, account }: { /** Whose figures these are, for a tool with more than one account here: the tool's own sign-in's. */ account?: string; tool: EngineTool; wins: Win[]; plan: string | null; note: string; roomy: boolean; history: History; now: number; cost: number | undefined; onCost: (usd: number | null) => void }) {
  // The five-hour first, then the week, then the rest (a model's own week, a month's allowance): the same order on every card.
  const order = [...wins.filter(isFiveHour), ...wins.filter((w) => isWeekly(w) && !isFiveHour(w)), ...wins.filter((w) => !isFiveHour(w) && !isWeekly(w))];
  // The one it meets first: the fullest; between two as full, the one that resets later holds it up longer.
  const hero = fullestOf(order);
  const f = hero ? forecastOf(hero, history[idOf(hero)] ?? [], now) : null;
  const out = !!hero && hero.used >= 100;
  const lv = hero ? level(hero.used) : "ok";
  // The strip of days: a week, all the history keeps (limitHistory.ts).
  const five = order.find(isFiveHour);
  const strip = dayStrip(five, history, now);
  return (
    <section className={cn("lh-card", out && "out")} data-level={hero ? lv : undefined} aria-label={ENGINE_NAMES[tool]}>
      <header className="lh-card-head">
        <EngineMark tool={tool} size={16} />
        <b>{ENGINE_NAMES[tool]}</b>
        {/* With two accounts, these figures are the tool's own sign-in's: said, so they aren't read as the one in use (Arun,
            2026-11-26). Every account's are in Accounts below. */}
        {account && <span className="lh-card-acct">{account}</span>}
        {/* Its plan as a chip after the name, without the tool's name again ("Antigravity Starter Quota" on Antigravity's card), and
            the first to give way: the tool's own name read "A." beside it (Arun, 2026-11-20: "fix this design please"). */}
        {plan && (
          <Badge size="md" className="lh-planchip" title={plan}>
            {plan.replace(new RegExp(`^${ENGINE_NAMES[tool].split(/\s+/)[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "") || plan}
          </Badge>
        )}
        {roomy && (
          <Badge size="md" tone="success" dot className="lh-room" title="Of your coding tools, the one with the most left of its fullest limit">
            Most room
          </Badge>
        )}
        {/* Out is a state, said in red beside the name, and when it's back at the end of the line. */}
        {out && (
          <Badge size="md" tone="danger" dot className="lh-outchip">
            Out of usage
          </Badge>
        )}
        {out && hero.resetsAt && <span className="lh-card-reset num">resets {resetWhen(hero)}</span>}
      </header>
      {/* Out, the card is the chip, the reset and its meters, as the polish mock draws it: the headline, the days and the cost come
          back with the window. */}
      {hero && !out ? (
        <div className="lh-hero">
          {/* What's left as the headline, with what it is of on the same line; the countdown is the rows' when there are rows. */}
          <p className="lh-hero-n">
            <span className={`lh-hero-big ${lv}`}>{Math.max(0, Math.round(100 - hero.used))}%</span>
            <span className="lh-hero-unit">
              left of its {ofName(hero)}
              {hero.resetsAt ? (
                // On a narrow card the rows already say when it resets, so the headline keeps to one line without it.
                <span className={cn(order.length > 1 && "lh-hero-reset")}>
                  {" "}· resets {resetWhen(hero)}
                  {order.length === 1 && <span className="num">, in {until(hero.resetsAt, now)}</span>}
                </span>
              ) : (
                " · reset time not reported"
              )}
            </span>
          </p>
          {/* The pace only once it says something: "Pace shows after a few readings" sat on every fresh card. */}
          {f && <p className={cn("lh-hero-pace", f.fullAt && "warn")}>{paceLine(hero, f, now)}</p>}
          {order.length === 1 && <WinBar w={hero} history={history} now={now} bare />}
        </div>
      ) : (
        !hero && <p className="lh-none">{note}</p>
      )}
      {(order.length > 1 || out) && (
        <ul className="lh-wrows" aria-label={`${ENGINE_NAMES[tool]}'s limits`}>
          {order.map((w) => (
            <WinBar key={idOf(w)} w={w} history={history} now={now} />
          ))}
        </ul>
      )}
      {!out && strip && <DayStrip w={five!} strip={strip} />}
      {!out && <CostLine tool={tool} plan={plan} cost={cost} onCost={onCost} />}
    </section>
  );
}

/**
 * A tool's five-hour window day by day: the highest it stood each of the last seven days, today in ink and a day it ran out in
 * red. Only once the readings kept here (limitHistory.ts, a week of them) cover two days or more; a fresh card has nothing to show.
 */
function dayStrip(w: Win | undefined, history: History, now: number) {
  if (!w) return null;
  const days = dailyPeaks(history[idOf(w)] ?? [], 7, now);
  const read = days.filter((d) => d.peak !== null);
  if (read.length < 2) return null;
  return { days, read, avg: read.length ? Math.round(read.reduce((n, d) => n + d.peak!, 0) / read.length) : null };
}
function DayStrip({ w, strip }: { w: Win; strip: NonNullable<ReturnType<typeof dayStrip>> }) {
  const { days, read, avg } = strip;
  return (
    <div className="lh-days">
      <div className="lh-days-head">
        <span className="lh-days-lbl">Per day</span>
        {avg !== null && <span className="num">avg {avg}% of a window</span>}
      </div>
      <div className="lh-days-bars" role="img" aria-label={`${shortName(w)} limit's highest each day: ${read.map((d) => `${d.label} ${d.peak}%`).join(", ")}`}>
        {days.map((d, i) => (
          <i key={d.label} className={cn(i === days.length - 1 && "today", d.peak === null ? "none" : d.peak >= 100 && "hot")} style={d.peak === null ? undefined : { height: `${Math.max(4, d.peak)}%` }} title={d.peak === null ? `${d.label}: not read` : `${d.label}: highest ${d.peak}%`} />
        ))}
      </div>
    </div>
  );
}

function CostLine({ tool, plan, cost, onCost }: { tool: EngineTool; plan: string | null; cost: number | undefined; onCost: (usd: number | null) => void }) {
  const list = listPrice(tool, plan);
  const usd = cost ?? list?.usd;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (editing)
    return (
      <form
        className="lh-cost"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim() === "" ? null : Number(text.replace(/[$,\s]/g, ""));
          onCost(v === null || Number.isFinite(v) ? v : null);
          setEditing(false);
        }}
      >
        <label className="lh-cost-edit">
          <span>$</span>
          <input autoFocus inputMode="decimal" aria-label={`What you pay for ${ENGINE_NAMES[tool]} a month`} value={text} placeholder={list ? String(list.usd) : "0"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <span>/ month</span>
        </label>
        <KitButton type="submit" variant="ghost" size="sm" className="ml-auto">
          Save
        </KitButton>
      </form>
    );
  return (
    <div className="lh-cost">
      <span className={cn("lh-cost-n", usd === undefined && "unknown")}>{usd === undefined ? "Cost unknown" : `$${usd % 1 ? usd.toFixed(2) : usd} / month`}</span>
      <span className="lh-cost-src">{cost !== undefined ? "your figure" : list ? `${list.tier} list price` : ""}</span>
      <KitButton variant="ghost" size="sm" className="ml-auto" onClick={() => (setText(usd !== undefined ? String(usd) : ""), setEditing(true))}>
        {usd === undefined ? "Add price" : "Edit"}
      </KitButton>
    </div>
  );
}

export function LimitsHub({ read, identity }: { read: Read; /** For the accounts and what can be done to them (account-glance.tsx). */ identity?: Identity }) {
  const limits = read && read !== "none" ? read : null;
  const [now, setNow] = useState(Date.now);
  // Countdowns move on the minute; the readings themselves come every two minutes (toolLimits.ts).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // A tool still being read when a reading was sent is asked again shortly by toolLimits.ts, for the rail as well as here.
  const history = useMemo(() => readHistory(), [read]); // eslint-disable-line react-hooks/exhaustive-deps
  const [costs, setCosts] = useState(readCosts);
  const wins = useMemo(() => windowsOf(limits, now), [limits, now]);

  if (read === null)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" role="status" aria-label="Reading your coding tools' limits">
        <Skeleton h={180} r={12} />
        <Skeleton h={180} r={12} />
      </div>
    );
  if (!limits)
    return (
      <EmptyState icon={<PlugIcon />} title="No computer connected" className="py-8">
        Connect your computer, and the limits of the coding tools on it show here.
      </EmptyState>
    );

  // Every tool with a window or a plan, the ones with windows first.
  // Claude Code read without a figure (it said only whether its limits allow the next turn) still gets its card: it was left
  // out altogether while the footer's card listed it (2026-10-27 audit).
  const claudeSaid = (limits.claudeWindows ?? []).filter((w) => w.kind !== "overage");
  const tools = ENGINE_TOOLS.filter((t) => wins.some((w) => w.tool === t) || planOf(t, limits) || (t === "claude" && claudeSaid.length > 0)).sort((a, b) => Number(wins.some((w) => w.tool === b)) - Number(wins.some((w) => w.tool === a)));
  const fives = wins.filter(isFiveHour);
  const room = mostRoom(wins);

  // One tool's week, hour by hour.
  const heat = (w: (typeof fives)[number]) => {
    const g = weekGrid(history[idOf(w)] ?? [], now);
    return (
      <div key={idOf(w)} className="lh-heat">
        <div className="lh-heat-head">
          <EngineMark tool={w.tool} size={14} />
          <b>{ENGINE_NAMES[w.tool]}</b>
          {groupOf(w) && <span className="lh-heat-of">{groupOf(w)}</span>}
          <span className="lh-heat-stats">
            {g.hits > 0 && <span className={g.hits > 1 ? "hot" : "warm"}>{g.hits}× full</span>}
            {g.busiest && g.busiest.used > 0 && <span>Peak {g.busiest.day} {g.busiest.hour % 12 || 12} {g.busiest.hour < 12 ? "AM" : "PM"}</span>}
          </span>
        </div>
        <div className="lh-heat-grid" role="img" aria-label={`${ENGINE_NAMES[w.tool]}'s ${groupOf(w) ? `${groupOf(w)} ` : ""}5-hour limit each hour this week${g.hits ? `, full ${g.hits} times` : ""}`}>
          <span aria-hidden />
          {[0, 6, 12, 18].map((h) => (
            <span key={h} className="lh-heat-hour" aria-hidden style={{ gridColumn: `${h + 2} / span 6` }}>
              {h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}
            </span>
          ))}
          {g.days.map((d) => (
            <div key={d.label} className="lh-heat-row">
              <span className="lh-heat-day">{d.label}</span>
              {d.hours.map((u, h) => (
                <i
                  key={h}
                  className={`lh-hcell ${u === null ? "" : level(u)}`}
                  style={u !== null && u < 70 ? { opacity: 0.35 + (u / 70) * 0.65 } : undefined}
                  title={u === null ? `${d.label} ${h}:00 · not read` : `${d.label} ${h}:00 · ${Math.round(u)}%`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  };
  const accountTools = (["claude", "codex"] as const).filter((t) => (limits.accounts?.[t]?.length ?? 0) > 1);
  // One tool alone: its week beside its card, not under a void the width of two more cards (audit REST-9, Arun 2026-11-04).
  const single = tools.length === 1 && fives.length === 1 && fives[0]!.tool === tools[0];

  return (
    <div className="flex flex-col gap-5">
      {/* No chips over the cards: the same percentages and resets were said three and four times (audit REST-11, Arun 2026-11-04). */}
      <div className={single ? "grid grid-cols-[minmax(300px,1fr)_minmax(0,2fr)] items-start gap-3 max-md:grid-cols-1" : "lh-cards"}>
        {tools.map((t) => (
          <ToolCard
            key={t}
            tool={t}
            wins={wins.filter((w) => w.tool === t)}
            plan={planOf(t, limits)}
            note={t === "claude" && claudeSaid.length ? (claudeSaid.some((w) => w.status === "rejected") ? "Out of usage for now: its limit was reached." : "Under its limit. Claude Code said so without a figure for how much is used.") : (limits.tools?.[t]?.why ?? "No limits reported on this plan.")}
            roomy={room?.tool === t}
            {...((t === "claude" || t === "codex") && (limits.accounts?.[t]?.length ?? 0) > 1 ? { account: limits.accounts![t]!.find((a) => a.id === "default")?.label ?? "Main" } : {})}
            history={history}
            now={now}
            cost={costs[t]}
            onCost={(v) => setCosts(saveCost(t, v))}
          />
        ))}
        {single && heat(fives[0]!)}
      </div>

      {/* Each tool's accounts (runner/accounts.ts), with who each is, its week and its 5 hours, and its menu; with no identity,
          the older cards of each one's windows. */}
      {identity ? (
        <UsageAccounts identity={identity} read={read} />
      ) : accountTools.length > 0 ? (
          <section className="flex flex-col gap-2.5" aria-label="Your accounts">
            <div className="lh-section-head">
              <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">Your accounts</h3>
              <span className="text-[12px] text-[var(--text-muted)]">In the order they refill. Friday never moves an agent between them by itself.</span>
            </div>
            {accountTools.map((t) => (
              <section key={t} className="flex flex-col gap-2" aria-label={`${ENGINE_NAMES[t]} accounts`}>
                <header className="flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
                  <EngineMark tool={t} size={14} />
                  <b className="font-semibold text-[var(--ink)]">{ENGINE_NAMES[t]}</b>
                  <span className="text-[var(--text-muted)]">{limits.accounts![t]!.length} accounts</span>
                </header>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  <AccountCardsView limits={read} tool={t} className={cn(surface, "flex flex-col gap-2 p-4")} />
                </div>
              </section>
            ))}
          </section>
      ) : null}

      {fives.length > 0 && !single && (
        <section className="lh-history" aria-label="Five-hour limits through the week">
          <div className="lh-section-head">
            <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">The week, hour by hour</h3>
            <span className="lh-legend" aria-hidden>
              <i className="lh-hcell" /> <i className="lh-hcell ok" style={{ opacity: 0.55 }} /> <i className="lh-hcell ok" /> <i className="lh-hcell warm" /> <i className="lh-hcell hot" /> full
            </span>
          </div>
          <div className="lh-heats">
            {fives.map(heat)}
          </div>
        </section>
      )}

    </div>
  );
}
