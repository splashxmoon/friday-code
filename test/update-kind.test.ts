// Whether the desktop app can replace itself (update-kind.ts): only an AppImage on Linux, any packaged copy on Mac and Windows.
import assert from "node:assert/strict";
import test from "node:test";
import { cannotSelfUpdate } from "../src/update-kind.js";

test("on Linux only an AppImage updates itself; a package manager's copy says who updates it", () => {
  assert.equal(cannotSelfUpdate("linux", { APPIMAGE: "/home/a/Friday-x86_64.AppImage" }), null);
  assert.match(cannotSelfUpdate("linux", {})!, /package manager/);
  assert.match(cannotSelfUpdate("linux", { APPIMAGE: "" })!, /package manager/);
});

test("Mac and Windows copies update themselves, AppImage or not", () => {
  assert.equal(cannotSelfUpdate("darwin", {}), null);
  assert.equal(cannotSelfUpdate("win32", {}), null);
});
