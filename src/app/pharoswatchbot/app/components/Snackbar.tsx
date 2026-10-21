"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const SUCCESS_HIDE_MS = 4_000;

export interface SnackbarMessage {
  /** Changes whenever a new message replaces the previous one. */
  key: string | number;
  tone: "success" | "error" | "warning";
  text: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Errors and warnings stay until dismissed; success hides itself unless an action is pending. */
  onDismiss?: () => void;
}

/**
 * One fixed bottom region for success, error and undo feedback, so the result of
 * an edit is visible wherever the user scrolled when they made it.
 */
export function Snackbar({ message }: { message: SnackbarMessage | null }) {
  const autoHide = message?.tone === "success" && !message.action ? message.onDismiss : undefined;
  const key = message?.key;

  useEffect(() => {
    if (!autoHide) return undefined;
    const timer = setTimeout(autoHide, SUCCESS_HIDE_MS);
    return () => clearTimeout(timer);
  }, [autoHide, key]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+var(--telegram-safe-area-bottom,0px)+0.75rem)] z-toast flex justify-center px-3"
    >
      {message ? (
        <div
          key={message.key}
          className={cn(
            "pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl py-1 pl-4 pr-1 text-sm shadow-lg",
            "bg-[color-mix(in_oklab,var(--mini-text)_88%,var(--mini-bg))] text-[color:var(--mini-bg)]",
          )}
        >
          {message.tone !== "success" ? (
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 shrink-0 rounded-full", message.tone === "error" ? "bg-state-danger-solid" : "bg-state-warn-solid")}
            />
          ) : null}
          <p className="min-w-0 flex-1 py-2 leading-snug">{message.text}</p>
          {message.action ? (
            <button
              type="button"
              onClick={message.action.onClick}
              disabled={message.action.disabled}
              className="pharos-focus-ring min-h-11 shrink-0 rounded-lg px-3 font-semibold whitespace-nowrap text-[color:var(--telegram-button,var(--mini-accent))] disabled:opacity-50"
            >
              {message.action.label}
            </button>
          ) : null}
          {message.onDismiss && (message.tone !== "success" || message.action) ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={message.onDismiss}
              className="pharos-focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-lg opacity-70"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
