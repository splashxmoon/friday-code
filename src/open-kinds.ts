import path from "node:path";

/**
 * What "Open" on a file hands to the app this computer opens it with (desktop-native.ts friday:open-file): documents,
 * pictures, sound and video. Anything else is shown in its folder instead. The page names the file, and an agent wrote it:
 * a .command, .terminal, .workflow, .jar, .exe, .bat or .lnk "opened" is a program run, on one press of a button that says
 * Open (security audit 2026-11-27, desktop L3). A list of what is safe, not of what isn't: new ways to run a file keep coming.
 */
const OPENS = new Set(
  ("pdf txt md markdown rtf csv tsv doc docx xls xlsx ppt pptx key pages numbers odt ods odp epub " +
    "png jpg jpeg gif webp avif svg heic bmp tif tiff ico " +
    "mp4 mov webm m4v mp3 wav m4a aac ogg flac " +
    "html htm")
    .split(" ")
    .map((e) => `.${e}`),
);

export const opensInItsApp = (file: string): boolean => OPENS.has(path.extname(file).toLowerCase());
