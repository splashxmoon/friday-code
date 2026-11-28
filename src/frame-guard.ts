/**
 * Whether a frame inside Friday's window is stopped from going to an address (both desktop apps' will-frame-navigate).
 *
 * A page an agent wrote (a live block in an answer, a page in the Work panel) is drawn in a frame with no origin of its own.
 * Its script could send the frame to any address, carrying what it read in that address, and whatever page answered would
 * then show inside the conversation as if it were Friday's (security audit 2026-11-27, client M2). So a frame with no origin
 * goes nowhere, except to load what Friday itself puts in such a frame: its frame page (page-csp.ts) and a backdrop's file.
 * The window's own page is will-navigate's to guard, and a frame with an origin (the editor, a PDF) is left alone.
 */
export function refusesFrameNavigation(o: { isMainFrame: boolean; url: string; frameUrl?: string | null; frameOrigin?: string | null; own: (url: string) => boolean }): boolean {
  if (o.isMainFrame || /^about:/i.test(o.url)) return false;
  if (o.frameUrl !== "about:srcdoc" && o.frameOrigin !== "null") return false;
  try {
    const p = new URL(o.url).pathname;
    if (o.own(o.url) && (p === "/api/frame" || p.startsWith("/api/local/backdrops/f/"))) return false;
  } catch {
    // Not an address: refused with the rest.
  }
  return true;
}
