"use client";

import { PageErrorBackLink, usePageErrorRetry } from "@/components/page-error-primitives";

export function PageError({
  title,
  error,
  reset,
}: {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { handleRetry, retryLabel, shouldHardReload } = usePageErrorRetry({ error, reset });
  const message =
    process.env.NODE_ENV === "development"
      ? error.message || "An unexpected error occurred."
      : shouldHardReload
        ? "A newer site version may be available. Reloading usually fixes this page."
        : "The data didn't reach this page. Try again, or check /status/ if it keeps happening.";

  return (
    <div className="space-y-6">
      <PageErrorBackLink />
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
        <h2 className="text-2xl font-bold font-mono tabular-nums">{title}</h2>
        <p className="text-muted-foreground text-sm">{message}</p>
        <button
          type="button"
          onClick={handleRetry}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          {retryLabel}
        </button>
      </div>
    </div>
  );
}
