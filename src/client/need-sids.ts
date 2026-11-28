// The sessions something waits on you in (Attention.tsx needSids), shared from the app with what isn't under it: the project
// overview's header button lights when any thread of its project needs you (ProjectOverview.tsx), without its own poll.
import { useSyncExternalStore } from "react";

let now: ReadonlySet<string> = new Set();
const subs = new Set<() => void>();

export function setNeedSids(next: ReadonlySet<string>): void {
  if (next.size === now.size && [...next].every((s) => now.has(s))) return;
  now = new Set(next);
  for (const f of subs) f();
}

export const useNeedSids = (): ReadonlySet<string> =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => now,
  );
