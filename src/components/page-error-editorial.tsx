"use client";

import { PageErrorBackLink, usePageErrorRetry } from "@/components/page-error-primitives";

interface PageErrorEditorialProps {
  /** Small all-caps kicker line above the title, e.g. *Lighthouse flickered*. */
  kicker: string;
  /** Editorial display title — the editorial framing of the failure. */
  title: string;
  /** One- to two-sentence Courier-italic body explaining the state. */
  body: string;
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Editorial shell for the root error boundary. Wraps the existing reset/reload
 * logic in the lighthouse register (CM5 IDEA-9). Smart status-aware recovery
 * is W7's responsibility — this layer only ships the voice.
 *
 * Serif here is Georgia (`font-serif`, the AiSummary precedent), not
 * Newsreader: error.tsx sits in every route's preload graph, and importing
 * `digestDisplay` from it preloaded the digest font CSS app-wide.
 */
export function PageErrorEditorial({ kicker, title, body, error, reset }: PageErrorEditorialProps) {
  const { handleRetry, retryLabel, shouldHardReload } = usePageErrorRetry({ error, reset });
  const devMessage = process.env.NODE_ENV === "development" ? error.message || null : null;
  const reloadMessage = shouldHardReload
    ? "A newer site version may be available. Reloading usually fixes this page."
    : null;
  const fallbackMessage = "The data didn't reach this page. Try again, or check /status/ if it keeps happening.";

  return (
    <div className="space-y-6">
      <PageErrorBackLink />
      <div className="mx-auto flex min-h-[50vh] max-w-2xl flex-col items-center justify-center gap-5 text-center">
        <BeamSvg />
        <p className="font-serif text-xs font-semibold uppercase tracking-[0.22em] text-frost-blue/80">
          {kicker}
        </p>
        <h2 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-foreground/95 sm:text-4xl">
          {title}
        </h2>
        <p className="max-w-xl font-mono text-sm italic leading-relaxed text-muted-foreground">{body}</p>
        {devMessage && (
          <pre className="max-w-xl whitespace-pre-wrap text-left font-mono text-xs text-muted-foreground/70">
            {devMessage}
          </pre>
        )}
        {!devMessage && (reloadMessage || fallbackMessage) && (
          <p className="text-xs font-mono text-muted-foreground/70">{reloadMessage ?? fallbackMessage}</p>
        )}
        <button
          type="button"
          onClick={handleRetry}
          className="pharos-focus-ring rounded-lg border border-border/70 bg-background/70 px-5 py-2 text-sm font-medium text-foreground/90 transition-colors hover:bg-accent"
        >
          {retryLabel}
        </button>
      </div>
    </div>
  );
}

/** Faded lighthouse-beam motif. Hairline stroke, low opacity. */
function BeamSvg() {
  return (
    <svg
      width="84"
      height="84"
      viewBox="0 0 84 84"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      className="text-frost-blue/35"
      aria-hidden="true"
    >
      <circle cx="42" cy="42" r="3" strokeWidth="1.2" />
      <path d="M42 39 L18 22" opacity="0.55" />
      <path d="M42 39 L66 22" opacity="0.35" />
      <path d="M42 45 L20 64" opacity="0.25" />
      <path d="M42 45 L64 64" opacity="0.45" />
      <path d="M42 38 L42 14" opacity="0.6" strokeDasharray="2 3" />
    </svg>
  );
}
