import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { BlobFace } from "./teammate-face.js";
import { ORDER, SPOTS, useFaces } from "./WhatsNew.js";
import "./first-launch.css";
import { markSeen } from "./FirstLaunch.js";

/** Each face's coding tool, left to right as they stand. */
const TOOLS: EngineTool[] = ["cursor", "codex", "claude", "gemini", "amp"];
/** Larger on the empty screen than in the sheet; they shrink to the sheet's sizes as they settle into it. */
const BIG = 1.7;
const GAP = 14;
const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Left to right, as the welcome's hero stands them (WhatsNew.tsx): where each one's middle is, its size, how much lower. */
function line(): { x: number; size: number; dy: number; i: number }[] {
  const spots = ORDER.map((i) => ({ i, size: SPOTS[i]!.size, dy: SPOTS[i]!.y }));
  const width = spots.reduce((a, s) => a + s.size, 0) + GAP * (spots.length - 1);
  let at = -width / 2;
  return spots.map((s) => {
    const x = at + s.size / 2;
    at += s.size + GAP;
    return { ...s, x };
  });
}

export function FirstLaunchPlay({ onHandOff, onDone }: { /** The sheet may show now: the crew are on their way into it. */ onHandOff: () => void; onDone: () => void }) {
  const faces = useFaces();
  const root = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState("");
  const stop = useRef(false);
  const spots = line();

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    stop.current = false;
    const $ = (s: string) => el.querySelector<HTMLElement | SVGElement>(s)!;
    const all = <T extends Element>(s: string) => [...el.querySelectorAll<T>(s)];
    const anim = (n: Element, frames: Keyframe[], o: KeyframeAnimationOptions) => n.animate(frames, { fill: "forwards", easing: "cubic-bezier(.2,.8,.2,1)", ...o }).finished.catch(() => {});
    let text = "";
    const show = () => setSaid(text);
    // A person's rhythm: quicker mid-word, a breath after a comma.
    const type = async (s: string, speed: number) => {
      for (const ch of s) {
        if (stop.current) return;
        text += ch;
        show();
        await sleep(ch === "," ? speed * 5 : ch === " " ? speed * 1.4 : speed * (0.7 + Math.random() * 0.6));
      }
    };
    const erase = async () => {
      while (text && !stop.current) {
        text = text.slice(0, -1);
        show();
        await sleep(14);
      }
    };
    const mates = all<HTMLElement>(".fl-mate").map((m, k) => ({ el: m, open: m.querySelector(".fl-open")!, shut: m.querySelector(".fl-shut")!, tool: m.querySelector(".fl-tool")!, shadow: m.querySelector(".fl-shadow")!, x: spots[k]!.x * BIG, y: spots[k]!.dy * BIG + 40, s: spots[k]! }));
    const at = (m: (typeof mates)[number], dy = 0) => `translate(${m.x}px, ${m.y + dy}px)`;

    void (async () => {
      await sleep(120);
      // The mark's three pieces, from where they point, turning, and meeting.
      const from = ["translate(-46px,-40px) rotate(-38deg) scale(.6)", "translate(46px,-40px) rotate(38deg) scale(.6)", "translate(0,56px) rotate(24deg) scale(.6)"];
      await Promise.all(all<SVGPathElement>(".fl-logo path").map((p, k) => anim(p, [{ transform: from[k]!, opacity: 0 }, { opacity: 1, offset: 0.35 }, { transform: "none", opacity: 1 }], { duration: 760, delay: k * 90, easing: SPRING })));
      if (stop.current) return;
      void anim($(".fl-logo"), [{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 420, easing: "ease-out" });
      await sleep(260);
      await type("Hi, I'm Friday.", 50);
      await sleep(520);
      if (stop.current) return;

      // The mark parts like a door and rises; the crew tumble out of it, asleep, onto a line under it.
      const part = ["translate(-7px,-5px)", "translate(7px,-5px)", "translate(0,8px)"];
      all<SVGPathElement>(".fl-logo path").forEach((p, k) => {
        void anim(p, [{ transform: "none" }, { transform: part[k]! }], { duration: 260, easing: "ease-out" });
        void anim(p, [{ transform: part[k]! }, { transform: "none" }], { duration: 360, delay: 380, easing: SPRING });
      });
      await sleep(140);
      void anim($(".fl-logo"), [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-196px) scale(.62)" }], { duration: 700, delay: 120, easing: "cubic-bezier(.65,0,.35,1)" });
      void anim($(".fl-say"), [{ transform: "translateY(0)" }, { transform: "translateY(64px)" }], { duration: 700, delay: 120, easing: "cubic-bezier(.65,0,.35,1)" });
      const out = [2, 1, 3, 0, 4];
      await Promise.all(
        out.map((k, n) => {
          const m = mates[k]!;
          return anim(
            m.el,
            [
              { opacity: 0, transform: `translate(0px, -20px) scale(.2) rotate(${(k - 2) * 30}deg)` },
              { opacity: 1, transform: `translate(${m.x * 0.55}px, ${-170 - Math.abs(m.x) * 0.2}px) scale(.9) rotate(${(k - 2) * 12}deg)`, offset: 0.45 },
              { transform: `${at(m)} scaleX(1.18) scaleY(.82)`, offset: 0.82 },
              { opacity: 1, transform: `${at(m)} scale(1)` },
            ],
            { duration: 820, delay: 160 + n * 110, easing: "cubic-bezier(.3,.7,.4,1)" },
          ).then(() => anim(m.shadow, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 }));
        }),
      );
      await sleep(250);

      // They wake, one after another: a squint, eyes open, a little hop.
      for (const k of [2, 0, 3, 1, 4]) {
        if (stop.current) return;
        const m = mates[k]!;
        void anim(m.open, [{ opacity: 0 }, { opacity: 1 }], { duration: 90, delay: 80 });
        void anim(m.shut, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, delay: 80 });
        void anim(m.el, [{ transform: `${at(m)} scale(1)` }, { transform: `${at(m)} scaleX(1.08) scaleY(.9)`, offset: 0.25 }, { transform: `${at(m, -14)} scaleX(.95) scaleY(1.06)`, offset: 0.6 }, { transform: `${at(m)} scale(1)` }], { duration: 420, easing: "ease-out" });
        await sleep(120);
      }
      await sleep(240);
      await erase();
      await sleep(160);
      await type("Your coding agents,", 38);
      await type(" working together.", 38);
      await sleep(420);
      await erase();
      if (stop.current) return;

      // Each catches its coding tool, flung in from above.
      void type("On the plans you already pay for.", 34);
      const fling = [[-560, -260], [-300, -420], [0, -480], [320, -420], [580, -260]];
      await Promise.all(
        mates.map((m, k) =>
          anim(m.tool, [{ opacity: 0, transform: `translate(${fling[k]![0]}px, ${fling[k]![1]}px) rotate(-90deg) scale(.6)` }, { opacity: 1, offset: 0.3 }, { opacity: 1, transform: "none" }], { duration: 640, delay: k * 120, easing: "cubic-bezier(.2,.9,.3,1.25)" }).then(() =>
            anim(m.el, [{ transform: `${at(m)} scale(1)` }, { transform: `${at(m)} scaleX(1.1) scaleY(.88)` }, { transform: `${at(m)} scale(1)` }], { duration: 260, easing: "ease-out" }),
          ),
        ),
      );
      await sleep(900);
      await erase();
      if (stop.current) return;

      // A wave down the line, for fun.
      void type("Let's get you set up.", 36);
      for (const m of mates) {
        void anim(m.el, [{ transform: at(m) }, { transform: at(m, -16), offset: 0.45 }, { transform: at(m) }], { duration: 380, easing: "cubic-bezier(.3,.7,.4,1)" });
        void anim(m.shadow, [{ transform: "scale(1)" }, { transform: "scale(.6)", opacity: 0.5, offset: 0.45 }, { transform: "scale(1)", opacity: 1 }], { duration: 380 });
        await sleep(80);
      }
      await sleep(900);
      if (stop.current) return;
      await handOff();
    })();

    // Into the welcome: the sheet comes up under the crew, who fly to its faces and become them; the mark and the words go.
    async function handOff() {
      onHandOff();
      void anim($(".fl-say"), [{ opacity: 1 }, { opacity: 0, transform: "translateY(100px)" }], { duration: 300, easing: "ease-in" });
      void anim($(".fl-logo"), [{ opacity: 1, transform: "translateY(-196px) scale(.62)" }, { opacity: 0, transform: "translateY(-240px) scale(.5)" }], { duration: 360, easing: "ease-in" });
      // The sheet's own faces, once it has drawn: where each of ours goes.
      let targets: DOMRect[] = [];
      for (let n = 0; n < 40 && targets.length < 5; n++) {
        await sleep(n ? 50 : 0);
        targets = [...document.querySelectorAll<HTMLElement>(".setup-overlay .wn-faces > span")].map((s) => s.getBoundingClientRect());
      }
      const box = el!.getBoundingClientRect();
      const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      // The stage's own scale in a small window (first-launch.css): a move inside it is that much shorter on screen.
      const k = new DOMMatrixReadOnly(getComputedStyle($(".fl-stage")).transform).a || 1;
      void anim(el!, [{ backgroundColor: getComputedStyle(el!).backgroundColor }, { backgroundColor: "transparent" }], { duration: 520, delay: 120 });
      await Promise.all(
        mates.map((m, k) => {
          void anim(m.tool, [{ opacity: 1 }, { opacity: 0, transform: "scale(.6)" }], { duration: 240, delay: 120 });
          void anim(m.shadow, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
          const t = targets[k];
          if (!t) return anim(m.el, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
          // Its feet to the middle of the bottom of its place in the sheet, at the sheet's size.
          return anim(m.el, [{ transform: `${at(m)} scale(1)` }, { transform: `translate(${(t.left + t.width / 2 - cx) / k}px, ${(t.bottom - cy) / k}px) scale(${1 / BIG / k})` }], { duration: 640, easing: "cubic-bezier(.65,0,.35,1)" });
        }),
      );
      finish();
    }
    function finish() {
      if (stop.current) return;
      stop.current = true;
      markSeen();
      onDone();
    }
    // Skip, or Escape: straight to the welcome. First, before the sheet's own Escape (which would close it).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      skipNow();
    };
    function skipNow() {
      if (stop.current) return;
      onHandOff();
      el!.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      void anim(el!, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).then(finish);
    }
    (el as HTMLDivElement & { skip?: () => void }).skip = skipNow;
    window.addEventListener("keydown", key, true);
    return () => {
      stop.current = true;
      window.removeEventListener("keydown", key, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="fl" ref={root} aria-label="Friday is starting" role="dialog" aria-modal="true">
      <div className="fl-drag" aria-hidden />
      <p className="fl-sr" aria-live="polite">
        {said.length > 3 ? said : ""}
      </p>
      <div className="fl-stage" aria-hidden>
        <svg className="fl-logo" viewBox="4 5 92 92">
          <path d="M44.40 7.23L11.46 26.25A2.6 2.6 0 0 0 10.16 28.50L10.16 66.53A2.6 2.6 0 0 0 14.06 68.79L33.98 57.29A2.6 2.6 0 0 0 35.28 55.04L35.28 43.00A2.6 2.6 0 0 1 36.58 40.75L47.00 34.73A2.6 2.6 0 0 0 48.30 32.48L48.30 9.48A2.6 2.6 0 0 0 44.40 7.23Z" />
          <path d="M51.70 9.48L51.70 32.48A2.6 2.6 0 0 0 53.00 34.73L63.42 40.75A2.6 2.6 0 0 1 64.72 43.00L64.72 55.04A2.6 2.6 0 0 0 66.02 57.29L85.94 68.79A2.6 2.6 0 0 0 89.84 66.53L89.84 28.50A2.6 2.6 0 0 0 88.54 26.25L55.60 7.23A2.6 2.6 0 0 0 51.70 9.48Z" />
          <path d="M15.76 76.23L48.70 95.25A2.6 2.6 0 0 0 51.30 95.25L84.24 76.23A2.6 2.6 0 0 0 84.24 71.73L64.32 60.23A2.6 2.6 0 0 0 61.72 60.23L51.30 66.25A2.6 2.6 0 0 1 48.70 66.25L38.28 60.23A2.6 2.6 0 0 0 35.68 60.23L15.76 71.73A2.6 2.6 0 0 0 15.76 76.23Z" />
        </svg>
        {spots.map((s, k) => {
          const size = s.size * BIG;
          return (
            <div key={s.i} className="fl-mate" style={{ left: -size / 2, top: -size, width: size, height: size }}>
              <span className="fl-shadow" />
              <span className="fl-shut">
                <BlobFace seed={faces[s.i]!} size={size} eyes="closed" />
              </span>
              <span className="fl-open">
                <BlobFace seed={faces[s.i]!} size={size} />
              </span>
              <span className="fl-tool">
                <EngineMark tool={TOOLS[k]!} size={20} />
              </span>
            </div>
          );
        })}
        <div className="fl-say">
          {said}
          <span className="fl-caret" />
        </div>
      </div>
      <button type="button" className="fl-skip" onClick={() => (root.current as (HTMLDivElement & { skip?: () => void }) | null)?.skip?.()}>
        Skip <kbd>esc</kbd>
      </button>
    </div>,
    document.body,
  );
}
