/**
 * Getting started's one mark the home box sets itself (Code.tsx, when a session starts in a folder the person picked). Kept apart
 * from GettingStarted.tsx so the box can note it while the checklist loads after the first screen (test/client-bundle.test.ts).
 */
export const OWN_FOLDER = "friday.gs.ownFolder";

/** Noted when a session starts in a folder the person chose. */
export const markOwnFolder = () => {
  try {
    localStorage.setItem(OWN_FOLDER, "1");
  } catch {
    // A tick: losing it shows the step again, nothing more.
  }
};
