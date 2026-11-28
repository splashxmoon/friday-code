"use client";
// beui.dev/components/agents/streaming-response

import {
  ChevronDown,
  RotateCcw,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useId,
  useState,
} from "react";
import type { MessageActionKey } from "@/components/affect/message-actions";
import {
  type CitationItem,
  CitationList,
  CitationStack,
} from "@/components/agents/citations";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { EASE_OUT, SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
import "./streaming-response.css";

// Copy and the thumbs are the kit's Message Actions (components/affect): fetched as this file loads, so the bar is in hand by the first
// answer, and kept out of the session screen's first download (test/client-bundle.test.ts).
const actionsKit = import("@/components/affect/message-actions");
const MessageActions = lazy(() => actionsKit.then((m) => ({ default: m.MessageActions })));

export type StreamingResponseStatus = "streaming" | "complete" | "error";
export type StreamingResponseFeedback = "up" | "down" | null;

export interface StreamingResponseProps {
  /** Rendered response content. Pass plain text or the output of a Markdown renderer. */
  children: ReactNode;
  status?: StreamingResponseStatus;
  /** Plain-text value copied by the built-in copy action. */
  copyText?: string;
  /** Overrides the built-in clipboard action. */
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  /** A Quote action beside Copy: the response's words into the message box as a quote. Given the button pressed. */
  onQuote?: (from: HTMLElement) => void;
  /** Optional sources shown as a compact footer disclosure after streaming. */
  sources?: CitationItem[];
  sourcesOpen?: boolean;
  defaultSourcesOpen?: boolean;
  onSourcesOpenChange?: (open: boolean) => void;
  sourceIdPrefix?: string;
  feedback?: StreamingResponseFeedback;
  defaultFeedback?: StreamingResponseFeedback;
  onFeedbackChange?: (feedback: StreamingResponseFeedback) => void;
  /** The reason picked in the bar's feedback row after a thumbs down. */
  onFeedbackReason?: (reason: string) => void;
  /** Set false when a surrounding conversation log announces streamed text. */
  announce?: boolean;
  /** Hides the built-in completion actions without changing response status. */
  showActions?: boolean;
  /** No thumbs under it: a crew mate's reply in the open-source edition (Activity.tsx). */
  noFeedback?: boolean;
  /** More controls at the end of the same row, for what only this surface knows to offer. */
  extraActions?: ReactNode;
  /** Quiet words at the row's far end, right-aligned: what the turn used. */
  actionsEnd?: ReactNode;
  /** What belongs to the answer under its words and above its row of actions: a card the agent drew as it answered. */
  below?: ReactNode;
  className?: string;
  contentClassName?: string;
  actionsClassName?: string;
}

function ResponseAction({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      transition={SPRING_PRESS}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </motion.button>
  );
}

export function StreamingResponse({
  children,
  status = "streaming",
  copyText,
  onCopy,
  onRetry,
  onQuote,
  sources = [],
  sourcesOpen,
  defaultSourcesOpen = false,
  onSourcesOpenChange,
  sourceIdPrefix,
  feedback,
  defaultFeedback = null,
  onFeedbackChange,
  onFeedbackReason,
  announce = true,
  showActions = true,
  noFeedback = false,
  extraActions,
  actionsEnd,
  below,
  className,
  contentClassName,
  actionsClassName,
}: StreamingResponseProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const [internalSourcesOpen, setInternalSourcesOpen] =
    useState(defaultSourcesOpen);
  const currentFeedback = feedback ?? defaultFeedback;
  const currentSourcesOpen = sourcesOpen ?? internalSourcesOpen;
  const streaming = status === "streaming";
  const complete = status === "complete";
  const canCopy = Boolean(copyText || onCopy);
  const hasSources = sources.length > 0;
  const shouldShowActions =
    showActions && !streaming && (canCopy || onRetry || complete || hasSources || Boolean(extraActions));
  const sourcesContentId = `${baseId}-sources`;
  const resolvedSourcePrefix =
    sourceIdPrefix ?? `response-source-${baseId.replace(/:/g, "")}`;
  const kitActions: MessageActionKey[] = [...(canCopy ? (["copy"] as const) : []), ...(complete && !noFeedback ? (["feedback"] as const) : [])];

  const setSourcesOpen = useCallback(
    (next: boolean) => {
      if (sourcesOpen === undefined) setInternalSourcesOpen(next);
      onSourcesOpenChange?.(next);
    },
    [onSourcesOpenChange, sourcesOpen],
  );

  return (
    <div
      data-state={status}
      data-ui-message=""
      aria-busy={streaming}
      className={cn("w-full", className)}
    >
      <div
        aria-live={announce ? "polite" : "off"}
        className={cn(
          "text-sm leading-6 text-foreground/90 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p+p]:mt-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/45 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
          contentClassName,
        )}
      >
        {children}
      </div>
      {below}

      <AnimatePresence initial={false}>
        {shouldShowActions ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
            className="mt-3"
          >
            <div className={cn("flex items-center gap-0.5", actionsClassName)}>
              {/* Quote beside Copy (Arun, 2026-11-04: "make clicking quote easier too"), in the bar's own 28px ghost style. */}
              {onQuote ? (
                <ResponseAction label="Quote in your message" onClick={(e) => onQuote(e.currentTarget)}>
                  {/* Solid, as the kit's own glyphs beside it are. */}
                  <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
                    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h2A1.5 1.5 0 0 1 8 4.5v2.2c0 2.6-1.3 4.6-3.6 5.8a.6.6 0 0 1-.8-.8c.9-.9 1.4-1.9 1.5-3.2H4.5A1.5 1.5 0 0 1 3 7V4.5Zm6 0A1.5 1.5 0 0 1 10.5 3h2A1.5 1.5 0 0 1 14 4.5v2.2c0 2.6-1.3 4.6-3.6 5.8a.6.6 0 0 1-.8-.8c.9-.9 1.4-1.9 1.5-3.2h-.6A1.5 1.5 0 0 1 9 7V4.5Z" />
                  </svg>
                </ResponseAction>
              ) : null}
              {/* Copy and the thumbs: the kit's bar, faded until the answer is pointed at; a thumbs down unfolds its reasons on a
                  line of their own under the row (rsp-mac lays the bar out as part of this row). */}
              {kitActions.length > 0 ? (
                <Suspense fallback={<span className="rsp-mac-wait" aria-hidden="true" />}>
                  <MessageActions
                    text={copyText}
                    actions={kitActions}
                    defaultVote={currentFeedback}
                    label="Response actions"
                    className="rsp-mac"
                    onCopy={() => void onCopy?.()}
                    onFeedback={(kind, reason) => (reason ? onFeedbackReason?.(reason) : onFeedbackChange?.(kind))}
                  />
                </Suspense>
              ) : null}
              {onRetry ? (
                <ResponseAction label="Retry response" onClick={onRetry}>
                  <RotateCcw className="size-4" strokeWidth={1.5} />
                </ResponseAction>
              ) : null}
              {hasSources ? (
                <button
                  type="button"
                  aria-expanded={currentSourcesOpen}
                  aria-controls={sourcesContentId}
                  onClick={() => setSourcesOpen(!currentSourcesOpen)}
                  className="group ml-1 inline-flex min-h-7 items-center gap-2 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CitationStack citations={sources} />
                  <span className="tabular-nums">
                    {sources.length} {sources.length === 1 ? "source" : "sources"}
                  </span>
                  <motion.span
                    aria-hidden="true"
                    animate={{ rotate: currentSourcesOpen ? 180 : 0 }}
                    transition={reduce ? { duration: 0 } : SPRING_SWAP}
                    className="text-muted-foreground/50 group-hover:text-muted-foreground"
                  >
                    <ChevronDown className="size-3" />
                  </motion.span>
                </button>
              ) : null}
              {extraActions ? <div className="ml-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{extraActions}</div> : null}
              {actionsEnd ? <span className="ml-auto shrink-0 pl-3">{actionsEnd}</span> : null}
            </div>

            {hasSources ? (
              <AgentDisclosure
                id={sourcesContentId}
                open={currentSourcesOpen}
              >
                <CitationList
                  citations={sources}
                  idPrefix={resolvedSourcePrefix}
                  className="mt-2 rounded-xl bg-muted p-2"
                />
              </AgentDisclosure>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
