// Security M3: preview_screenshot and proof clips are held off Friday's own page on this computer, as the agents' browser is.
import assert from "node:assert/strict";
import test from "node:test";
import { ownLocalApp } from "../src/browser-driver.js";
import { capture, clipViaDesktop, holdOffOwnApp, useInProcessCapture } from "../src/runner/screenshot.js";

test("Friday's own address is told from a page an agent started, by any name for this computer", () => {
  const app = "http://127.0.0.1:4321";
  for (const u of ["http://127.0.0.1:4321/", "http://127.0.0.1:4321/?session=abc", "http://[::1]:4321/", "http://0.0.0.0:4321/x", "http://127.0.0.2:4321/", "http://app.localhost:4321/"]) assert.equal(ownLocalApp(u, app), true, u);
  // The previews' own address beside it answers previews only; another port is another page.
  for (const u of ["http://localhost:4321/", "http://localhost:5173/", "http://127.0.0.1:5173/", "https://example.com/"]) assert.equal(ownLocalApp(u, app), false, u);
  // A Friday on the web is no page of this computer: nothing here is its own.
  assert.equal(ownLocalApp("http://localhost:443/", "https://www.app.tryfridaywork.com"), false);
  assert.equal(ownLocalApp("http://127.0.0.1:4321/", null), false);
});

test("no picture and no clip is taken of Friday's own page, and the app that takes them is told the address to refuse", async (t) => {
  const asked: { url: string; own?: string }[] = [];
  useInProcessCapture({
    capture: async (shot) => (asked.push(shot), { data: "aGk=", mimeType: "image/png", width: 10, height: 10 }),
    clip: async (ask) => (asked.push(ask), { data: "aGk=", mimeType: "video/webm", width: 10, height: 10, durationMs: 1, marks: [], errors: [], stops: [] }),
  });
  holdOffOwnApp("http://127.0.0.1:4321");
  t.after(() => (useInProcessCapture(null), holdOffOwnApp(null)));
  const shot = { width: 800, height: 600, fullPage: false };
  assert.match((await capture({ ...shot, url: "http://127.0.0.1:4321/?session=s1" })).error ?? "", /Friday's own page/);
  assert.match((await capture({ ...shot, url: "http://[::1]:4321/" })).error ?? "", /Friday's own page/);
  assert.match((await clipViaDesktop({ url: "http://127.0.0.1:4321/", width: 800, height: 600 })).error ?? "", /Friday's own page/);
  assert.equal(asked.length, 0, "the app was never asked for any of them");
  assert.ok((await capture({ ...shot, url: "http://localhost:5173/" })).data, "a page the agent started is captured as before");
  assert.ok((await clipViaDesktop({ url: "http://localhost:5173/", width: 800, height: 600 })).data);
  assert.deepEqual(asked.map((a) => a.own), ["http://127.0.0.1:4321", "http://127.0.0.1:4321"], "and the app is told what a redirect must not reach");
});
