"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const SUCCESS_HIDE_MS = 4_000;

export interface SnackbarMessage {
  /** Changes whenever a new message replaces the previous one. */
  key: string | number;
  tone: "success" | "error" | "warning";
  text: React.ReactNode;
  /** Set to `"off"` for ticking countdowns so assistive tech is not spammed every second. */
  live?: "polite" | "off";
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Errors and warnings stay until dismissed; success hides itself unless an action is pending. */
  onDismiss?: () => void;
}

/**
 * One fixed bottom region for success, error and undo feedback, so the result of
 * an edit is visible wherever the user scrolled when they made it.
 */
export function Snackbar({ message, mainButtonVisible = false }: {
  message: SnackbarMessage | null;
  /** When Telegram's native MainButton owns the bottom edge, omit the hardware home-bar inset. */
  mainButtonVisible?: boolean;
}) {
  const autoHide = message?.tone === "success" && !message.action ? message.onDismiss : undefined;
  const key = message?.key;
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    if (!autoHide) return undefined;
    const timer = setTimeout(autoHide, SUCCESS_HIDE_MS);
    return () => clearTimeout(timer);
  }, [autoHide, key]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const update = () => {
      const next = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      setKeyboardInset(next);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  const isLiveOff = message?.live === "off";
  const keyboardStyle = keyboardInset > 0
    ? ({ "--mini-keyboard-inset": `${keyboardInset}px` } as CSSProperties)
    : undefined;

  return (
    <div
      role={isLiveOff ? undefined : "status"}
      aria-live={isLiveOff ? "off" : "polite"}
      style={keyboardStyle}
      className={cn(
        "pointer-events-none fixed inset-x-0 z-toast flex justify-center pl-[calc(var(--mini-safe-left)+0.75rem)] pr-[calc(var(--mini-safe-right)+0.75rem)]",
        mainButtonVisible
          ? "bottom-[calc(var(--telegram-content-safe-area-bottom,0px)+var(--mini-keyboard-inset,0px)+0.75rem)]"
          : "bottom-[calc(var(--mini-safe-bottom)+var(--mini-keyboard-inset,0px)+0.75rem)]",
      )}
    >
      {message ? (
        <div
          key={message.key}
          className={cn(
            "pointer-events-auto flex w-full max-w-lg items-center gap-2 rounded-xl py-1 pl-4 pr-1 text-sm shadow-lg",
            "bg-[var(--telegram-snackbar-bg,color-mix(in_oklab,var(--mini-text)_88%,var(--mini-bg)))] text-[color:var(--mini-bg)]",
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
              className="min-h-11 shrink-0 rounded-lg px-3 font-semibold whitespace-nowrap text-[color:var(--telegram-snackbar-action,var(--telegram-button,var(--mini-accent)))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--telegram-snackbar-ring,var(--mini-bg))] disabled:opacity-50"
            >
              {message.action.label}
            </button>
          ) : null}
          {message.onDismiss && (message.tone !== "success" || message.action) ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={message.onDismiss}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--telegram-snackbar-ring,var(--mini-bg))]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
