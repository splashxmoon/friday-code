/**
 * Whether this copy of the desktop app can replace itself, apart from Electron (desktop-update.ts asks; tests read it plainly).
 *
 * On Linux the updater can only swap an AppImage, which its runtime marks with APPIMAGE (the file's path). Friday unpacked from
 * one and installed by a package manager (the AUR's friday-bin, #47) has no AppImage to swap: the check went round from
 * "checking" to "The update stopped downloading" and back for good (Efer-Eder, 2026-11-26, testing the AUR package). There the
 * package manager updates Friday, so the app says so and doesn't try.
 */
export function cannotSelfUpdate(platform: NodeJS.Platform, env: Record<string, string | undefined>): string | null {
  if (platform === "linux" && !env.APPIMAGE) return "This copy of Friday was installed by your package manager, which keeps it up to date.";
  return null;
}
