"use client";

import { Trash2 } from "lucide-react";

export function ForgottenView({ onClose }: { onClose?: () => void }) {
  return (
    <section className="pharos-mini-app flex min-h-[max(var(--telegram-viewport-height,100svh),100svh)] flex-col justify-center bg-[var(--mini-panel)] text-[var(--telegram-text,var(--foreground))] pt-[calc(var(--mini-safe-top)+1rem)] pb-[calc(var(--mini-safe-bottom)+1rem)] pl-[calc(var(--mini-safe-left)+1rem)] pr-[calc(var(--mini-safe-right)+1rem)]">
      <div className="mx-auto w-full max-w-lg">
        <section role="status" className="rounded-xl bg-[var(--mini-card)] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--mini-accent-fill)] text-[color:var(--mini-accent)]">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 tabIndex={-1} className="outline-none text-lg font-semibold tracking-tight text-foreground">
                Your data has been deleted
              </h1>
              <p className="mt-1 text-sm leading-snug text-muted-foreground">
                Every alert and preference tied to your chat has been removed.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                You can close this window now. Send <code className="pharos-numeric rounded-sm bg-muted px-1 py-0.5 text-foreground">/start</code> to @PharosWatchBot anytime to set up alerts again.
              </p>
            </div>
          </div>
          {onClose ? (
            <div className="mt-5">
              <button
                type="button"
                aria-label="Close Mini App"
                onClick={onClose}
                className="pharos-focus-ring inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-[var(--telegram-button,var(--mini-accent))] px-4 text-sm font-semibold text-[color:var(--telegram-button-text,white)] transition-opacity active:opacity-80"
              >
                Close
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}
