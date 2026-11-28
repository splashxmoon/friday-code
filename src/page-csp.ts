/**
 * The Content-Security-Policy of Friday's own pages (the app's shell and the launch console), and the frame an agent's page is
 * drawn in.
 *
 * Why the app needs one more than most: script running on this origin is not "just XSS". The page can start agents and
 * terminals on a linked computer, and in the desktop apps it holds the bridge that opens a shell (security audit, 2026-11-27,
 * desktop H1 and client M3). So only Friday's own script files run, plus the page's few inline scripts by their hash; no
 * inline handlers, no eval, no plugins, no `<base>` pointed elsewhere, no form sent to another site.
 *
 * What is looser than it could be, and why (each is something the app really loads):
 * - `script-src 'wasm-unsafe-eval'`: the code highlighter (shiki's Oniguruma engine) is WebAssembly. That lets WebAssembly be
 *   compiled, never a string be run as JavaScript.
 * - `script-src blob:`: voice input's audio worklet is made from a blob (client/voice.ts). Only script can make one.
 * - `style-src 'unsafe-inline'`: React's `style` props, CodeMirror, motion and the terminal all write styles inline.
 * - `img-src https: http:`: a plugin's logo comes from its own site, a teammate's face from their sign-in provider, and a
 *   picture in an answer from wherever it is once the person asks to see it (client/LiveBlock.tsx holds it until then).
 * - `frame-src https: http:`: in a browser the Preview and the Work browser frame whatever address the person types (the
 *   desktop apps use a webview, which this doesn't govern).
 * - `form-action` and loopback: the built-in editor signs in by a form posted to code-server on 127.0.0.1.
 */
import { createHash } from "node:crypto";

/** `'sha256-…'` for each inline script in a page, as the browser hashes it: the text between the tags, byte for byte. */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!) || !m[2]) continue;
    out.add(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return [...out];
}

/** A Host header as a CSP source, or nothing when it isn't plainly a host (it is the client's own header: never trusted as text). */
const hostSource = (host: string | undefined): string => (host && /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host) ? host : "");

/**
 * The policy for one of Friday's own pages, from the page itself (its inline scripts are allowed by hash, so a script
 * somebody managed to add to it is not), the host it was asked on (its WebSocket, said outright for browsers that don't read
 * `'self'` as covering it) and the preview origin when previews have one of their own.
 */
export function appCsp(html: string, o: { host?: string; preview?: string } = {}): string {
  const host = hostSource(o.host);
  const preview = o.preview && /^https?:\/\/[^\s;,'"]+$/i.test(o.preview) ? ` ${o.preview}` : "";
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval' blob:", ...inlineScriptHashes(html)].join(" "),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob:",
    `connect-src 'self' data: blob:${host ? ` ws://${host} wss://${host}` : ""}${preview}`,
    "frame-src 'self' https: http:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' http://127.0.0.1:* http://localhost:*",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Where the pages agents make may load their libraries from: the public CDNs, nowhere else (client/LiveBlock.tsx, WorkPanels.tsx). */
const FRAME_CDNS = "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://cdn.tailwindcss.com";

/** Where the frame below is served. */
export const FRAME_PATH = "/api/frame";

/**
 * The frame an agent's page is drawn in (a live block in an answer, a page in the Work panel). It used to be a `srcdoc`
 * frame, which takes the policy of the page around it: under the app's own policy above, none of an agent's inline scripts
 * would run. So it is a page of its own, with its own policy as a header (which the agent's markup can't come before, as it
 * could a `<meta>`): no origin (`sandbox`), scripts and libraries from the public CDNs, pictures and sound only from itself
 * or this address's folder passes, and nothing sent anywhere. Each use narrows it further with a `<meta>` first in what it
 * writes. The page is one script: it writes the document it was handed in its name (the frame's `name`, set by the page that
 * made the frame). Only inside a frame, and only Friday may frame it (frame-ancestors): opened in a window of its own by
 * some other site, with a name of that site's choosing, it writes nothing, so it can't be made to show a made-up page at
 * Friday's address.
 */
export const FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${FRAME_CDNS}`,
  `style-src 'unsafe-inline' ${FRAME_CDNS} https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com ${FRAME_CDNS} data:`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export const FRAME_PAGE = `<!doctype html><meta charset="utf-8"><script>if(parent!==window){var d=name;document.open();document.write(d);document.close()}</script>`;
