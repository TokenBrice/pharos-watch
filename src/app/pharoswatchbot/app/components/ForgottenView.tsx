"use client";

import { Trash2 } from "lucide-react";
import { MiniButton } from "./MiniButton";

export function ForgottenView({ onClose }: { onClose: () => void }) {
  return (
    <section className="mx-auto flex min-h-[100svh] max-w-lg flex-col justify-center px-4 py-8">
      <section role="status" className="rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            <Trash2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Your data has been deleted</h1>
            <p className="mt-1 text-xs text-muted-foreground">Every alert and preference tied to your chat has been removed.</p>
          </div>
        </div>
        <div className="mt-5">
          <MiniButton onClick={onClose} ariaLabel="Close Mini App">Close</MiniButton>
        </div>
      </section>
    </section>
  );
}
