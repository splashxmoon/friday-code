// The project overview's mark: one card over two, a line from the top one branching to each. Kept out of icons.tsx, which loads
// with the first screen, since only the session screen's header and the overview page draw it.
export function TreeMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8.5" y="3" width="7" height="5.5" rx="1.8" />
      <rect x="3" y="15.5" width="7" height="5.5" rx="1.8" />
      <rect x="14" y="15.5" width="7" height="5.5" rx="1.8" />
      <path d="M12 8.5V12M6.5 15.5V13.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v2" />
    </svg>
  );
}
