import type { CSSProperties } from "react";
import { KeyRound, LockOpen } from "lucide-react";
import type { FailureScenarioEvidence } from "@shared/types/failure-scenarios";
import { cn } from "@/lib/utils";
import { EVIDENCE_LABEL, type NumberedSource } from "./scenario-model";

/**
 * Evidence support as a shape, strongest to weakest: a filled disc
 * (verified onchain), a half disc (documented), a dashed ring (inferred) and a
 * dotted ring (unverified). Neutral ink only: support is confidence, not
 * risk, so it never borrows the severity ramp. The label always travels with
 * the glyph, so the shape is never the only signal.
 */
export function EvidenceGlyph({ evidence, className }: { evidence: FailureScenarioEvidence; className?: string }) {
  const muted = evidence === "inferred" || evidence === "unverified";
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={cn("h-3 w-3 shrink-0", muted ? "text-muted-foreground" : "text-foreground/80", className)}
    >
      {evidence === "verified-onchain" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {evidence === "documented" ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 0 0 8.5Z" fill="currentColor" />
        </>
      ) : null}
      {evidence === "inferred" ? (
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" />
      ) : null}
      {evidence === "unverified" ? (
        <circle
          cx="6"
          cy="6"
          r="4.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="0.1 2.4"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

export function EvidenceMarker({ evidence, className }: { evidence: FailureScenarioEvidence; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <EvidenceGlyph evidence={evidence} />
      <span>
        <span className="sr-only">Evidence: </span>
        {EVIDENCE_LABEL[evidence]}
      </span>
    </span>
  );
}

/**
 * Inline numbered citations: each number links straight to its source (the
 * full list folds into the module footer), so a citation never depends on an
 * in-page jump into a closed disclosure. 24 px targets (WCAG 2.5.8). `bare`
 * drops the visible "Sources" word where the boxes sit beside an evidence
 * marker; each link still names its source.
 */
export function CitationLinks({ sources, bare = false }: { sources: readonly NumberedSource[]; bare?: boolean }) {
  if (sources.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {bare ? null : <span>{sources.length === 1 ? "Source" : "Sources"}</span>}
      {sources.map((source) => (
        <a
          key={source.id}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.label}
          aria-label={`Source ${source.number}: ${source.label}`}
          className="pharos-focus-ring pharos-numeric inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-border/70 px-1 text-[11px] text-foreground/80 transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          {source.number}
        </a>
      ))}
    </span>
  );
}

/**
 * "The lock that isn't there": an open padlock in a dashed ring, the one
 * muted-warning mark the scenario uses for a missing defense, on the route
 * map's hops and on each step. Decorative: the defense text always travels
 * beside it or in the step list.
 */
export function MissingDefenseMark({ size = "md", className }: { size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-amber-600/55 bg-card dark:border-amber-400/50",
        size === "sm" ? "h-4 w-4" : "h-5 w-5",
        className,
      )}
    >
      <LockOpen className={cn("text-amber-700 dark:text-amber-400", size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3")} />
    </span>
  );
}

/** A route's key threshold ("3 of 5", "1 key"), the fork's headline fact. */
export function KeysPill({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/80 bg-card px-1.5 py-px text-[11px] font-semibold tabular-nums text-foreground",
        className,
      )}
    >
      <KeyRound aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
      {children}
    </span>
  );
}

/**
 * A step's position, drawn the same on the route map, the clock and the step
 * list: a ruled box, dashed for a hypothetical step, and filled ink for the
 * path's outcome (the one filled mark in the module). `label` overrides the
 * text for a clock flag that stands for several steps ("2–4").
 */
export function StepNumber({
  number,
  label,
  hypothetical,
  terminal,
  className,
  style,
}: {
  number?: number;
  label?: string;
  hypothetical: boolean;
  terminal: boolean;
  className?: string;
  /** Position on the clock's ruler. */
  style?: CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cn(
        "pharos-numeric inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-[5px] border px-1 text-[11px] font-semibold leading-none",
        terminal
          ? "border-foreground bg-foreground text-background"
          : hypothetical
            ? "border-dashed border-muted-foreground/70 bg-card text-foreground"
            : "border-foreground/30 bg-card text-foreground",
        className,
      )}
    >
      {label ?? number}
    </span>
  );
}
