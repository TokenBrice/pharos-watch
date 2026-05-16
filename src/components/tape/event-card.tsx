"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import {
  Activity,
  ArrowLeftRight,
  Award,
  BookOpen,
  Calendar,
  Check,
  Coins,
  Flame,
  Link2,
  Lock,
  Radar,
  Rocket,
  Skull,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  deviationBgClass,
  deviationColorClass,
} from "@/lib/severity-colors";
import { tapeClassRowBg, tapeClassChipBg } from "@/lib/tape-class-style";
import { formatCompactUsd } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

function eventClass(type: string): string {
  const dot = type.indexOf(".");
  return dot === -1 ? type : type.slice(0, dot);
}

interface ClassIconProps {
  type: string;
  className?: string;
}

// Per-class icon. Inline rather than via a registry so React doesn't see a
// component re-created on every render (eslint react-hooks/static-components).
function ClassIcon({ type, className = "h-4 w-4" }: ClassIconProps) {
  switch (eventClass(type)) {
    case "depeg":       return <TrendingDown className={className} aria-hidden="true" />;
    case "freeze":      return <Lock className={className} aria-hidden="true" />;
    case "redemption":  return <ArrowLeftRight className={className} aria-hidden="true" />;
    case "psi":         return <Activity className={className} aria-hidden="true" />;
    case "mint_burn":   return <Flame className={className} aria-hidden="true" />;
    case "reserve":     return <Wallet className={className} aria-hidden="true" />;
    case "methodology": return <BookOpen className={className} aria-hidden="true" />;
    case "cemetery":    return <Skull className={className} aria-hidden="true" />;
    case "score":       return <Award className={className} aria-hidden="true" />;
    case "dews":        return <Radar className={className} aria-hidden="true" />;
    case "liquidity":   return <Coins className={className} aria-hidden="true" />;
    case "lifecycle":   return <Rocket className={className} aria-hidden="true" />;
    default:            return <Calendar className={className} aria-hidden="true" />;
  }
}

export const SEVERITY_LABEL: Record<TapeEventSeverity, string> = {
  info: "Info+",
  notice: "Notice+",
  warning: "Warning+",
  severe: "Severe+",
  critical: "Critical",
};

// Severity is communicated via text color on the inline tag — the wire-service
// stream deliberately omits border-l rails and badge chrome (see
// docs/tape-page.md Visual Identity for the locked-in rules).
const SEVERITY_TEXT: Record<TapeEventSeverity, string> = {
  info: "text-zinc-600 dark:text-zinc-400",
  notice: "text-sky-700 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-400",
  severe: "text-orange-700 dark:text-orange-400",
  critical: "text-red-700 dark:text-red-400",
};

function formatRelativeTime(tsMs: number): string {
  const ageSec = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}

function formatHhMm(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatAbsoluteDate(tsMs: number): string {
  return new Date(tsMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function deriveTicker(event: TapeEvent): string | null {
  if (event.coinId) {
    const symbol = TRACKED_META_BY_ID.get(event.coinId)?.symbol;
    if (symbol) return symbol;
  }
  const payloadSymbol = event.payload?.symbol;
  if (typeof payloadSymbol === "string" && payloadSymbol.length > 0) return payloadSymbol;
  return null;
}

// ---------------------------------------------------------------------------
// Per-class body enrichment
//
// One internal switch component, three small renderers — kept inline rather
// than extracted to a registry so we mirror the existing `ClassIcon` pattern
// (no static-component lint hits, no bundle indirection).
//
// Phase 1 covers depeg + score + methodology — the three classes whose payload
// holds non-redundant detail today. Other classes fall through and render
// the title/summary baseline only.
// ---------------------------------------------------------------------------

const DEPEG_BAR_MAX_BPS = 500;

interface DepegPayload {
  absBps: number;
  signedBps: number;
  direction: "above" | "below";
  prevAbsBps: number | null;
}

function readDepegPayload(event: TapeEvent): DepegPayload | null {
  const p = event.payload;
  const abs = p?.absDeviationBps;
  const dir = p?.direction;
  if (typeof abs !== "number") return null;
  if (dir !== "above" && dir !== "below") return null;
  const signed = typeof p.signedDeviationBps === "number" ? p.signedDeviationBps : abs;
  const prev = typeof p.prevAbsDeviationBps === "number" ? p.prevAbsDeviationBps : null;
  return { absBps: abs, signedBps: signed, direction: dir, prevAbsBps: prev };
}

function DepegEnrichment({ event }: { event: TapeEvent }) {
  const data = readDepegPayload(event);
  if (!data) return null;
  const { absBps, direction, prevAbsBps } = data;
  const sign = direction === "below" ? "−" : "+";
  const ArrowIcon = direction === "below" ? TrendingDown : TrendingUp;
  const fillPct = Math.min(100, Math.round((absBps / DEPEG_BAR_MAX_BPS) * 100));
  const barColor = deviationBgClass(absBps);
  const textColor = deviationColorClass(absBps);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      <span aria-hidden="true" className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span className={`absolute left-0 top-0 h-full ${barColor}`} style={{ width: `${fillPct}%` }} />
      </span>
      <span className={`inline-flex items-center gap-1 tabular-nums ${textColor}`}>
        <ArrowIcon className="h-3 w-3" aria-hidden="true" />
        {sign}
        {absBps} bps
      </span>
      {prevAbsBps != null ? (
        <span className="font-mono text-[11px] text-muted-foreground">
          {sign}
          {prevAbsBps} → {sign}
          {absBps}
        </span>
      ) : null}
      <span className="sr-only">
        Deviation: {sign}
        {absBps} basis points, {direction} peg
      </span>
    </div>
  );
}

const SCORE_PILL_CLASS =
  "inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums";

function ScoreEnrichment({ event }: { event: TapeEvent }) {
  const p = event.payload;
  const prev = typeof p?.prevGrade === "string" ? p.prevGrade : null;
  const next = typeof p?.newGrade === "string" ? p.newGrade : null;
  if (!prev || !next) return null;
  const prevScore = typeof p.prevScore === "number" ? p.prevScore : null;
  const newScore = typeof p.newScore === "number" ? p.newScore : null;
  const isUpgrade = event.type === "score.upgraded";
  const ArrowIcon = isUpgrade ? TrendingUp : TrendingDown;
  const arrowColor = isUpgrade
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`${SCORE_PILL_CLASS} text-muted-foreground`}>{prev}</span>
      <ArrowIcon className={`h-3 w-3 ${arrowColor}`} aria-hidden="true" />
      <span className={`${SCORE_PILL_CLASS} text-foreground`}>{next}</span>
      {prevScore != null && newScore != null ? (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {prevScore} → {newScore}
          <span className={`ml-1 ${arrowColor}`}>
            ({newScore - prevScore > 0 ? "+" : ""}
            {newScore - prevScore})
          </span>
        </span>
      ) : null}
    </div>
  );
}

const BAND_PILL_CLASS =
  "inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide";

function BandTransitionEnrichment({ event }: { event: TapeEvent }) {
  const p = event.payload;
  const prev = typeof p?.prevBand === "string" ? p.prevBand : null;
  const next = typeof p?.newBand === "string" ? p.newBand : null;
  if (!prev || !next) return null;
  const prevScore = typeof p.prevScore === "number" ? p.prevScore : null;
  const newScore = typeof p.newScore === "number" ? p.newScore : null;
  const isEscalation = event.type.endsWith(".shifted_down") || event.type === "dews.escalated";
  const ArrowIcon = isEscalation ? TrendingDown : TrendingUp;
  const arrowColor = isEscalation
    ? "text-red-600 dark:text-red-400"
    : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`${BAND_PILL_CLASS} text-muted-foreground`}>{prev}</span>
      <ArrowIcon className={`h-3 w-3 ${arrowColor}`} aria-hidden="true" />
      <span className={`${BAND_PILL_CLASS} text-foreground`}>{next}</span>
      {prevScore != null && newScore != null ? (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {prevScore.toFixed(1)} → {newScore.toFixed(1)}
          <span className={`ml-1 ${arrowColor}`}>
            ({newScore - prevScore > 0 ? "+" : ""}
            {(newScore - prevScore).toFixed(1)})
          </span>
        </span>
      ) : null}
    </div>
  );
}

function YieldEnrichment({ event }: { event: TapeEvent }) {
  const p = event.payload;
  if (event.type === "yield.pys_dropped") {
    const prev = typeof p?.prevScore === "number" ? p.prevScore : null;
    const next = typeof p?.newScore === "number" ? p.newScore : null;
    if (prev == null || next == null) return null;
    const delta = next - prev;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span className={`${SCORE_PILL_CLASS} text-muted-foreground`}>{Math.round(prev)}</span>
        <TrendingDown className="h-3 w-3 text-red-600 dark:text-red-400" aria-hidden="true" />
        <span className={`${SCORE_PILL_CLASS} text-foreground`}>{Math.round(next)}</span>
        <span className="font-mono text-[11px] tabular-nums text-red-600 dark:text-red-400">
          ({delta > 0 ? "+" : ""}{Math.round(delta)})
        </span>
      </div>
    );
  }
  // yield.warning_emitted
  const signals = Array.isArray(p?.newSignals) ? p.newSignals : Array.isArray(p?.signals) ? p.signals : null;
  if (!signals || signals.length === 0) return null;
  const visible = signals.slice(0, 3).filter((s): s is string => typeof s === "string");
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      {visible.map((signal) => (
        <span
          key={signal}
          className="inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
        >
          {signal}
        </span>
      ))}
      {signals.length > visible.length ? (
        <span className="font-mono text-[10px] text-muted-foreground">+{signals.length - visible.length} more</span>
      ) : null}
    </div>
  );
}

function MintBurnFlowEnrichment({ event }: { event: TapeEvent }) {
  const amount = event.payload?.amountUsd;
  if (typeof amount !== "number" || amount <= 0) return null;
  const direction = event.payload?.direction;
  const verb = direction === "mint" ? "minted" : direction === "burn" ? "burned" : "flow";
  const ArrowIcon = direction === "mint" ? TrendingUp : TrendingDown;
  const arrowColor = direction === "mint"
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-orange-600 dark:text-orange-400";
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-xs">
      <ArrowIcon className={`h-3 w-3 ${arrowColor}`} aria-hidden="true" />
      <span className="inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground/80">
        {formatCompactUsd(amount)}
      </span>
      <span className="text-[11px] text-muted-foreground">{verb}</span>
    </div>
  );
}

const METHODOLOGY_BULLET_LIMIT = 2;

function MethodologyEnrichment({ event }: { event: TapeEvent }) {
  const raw = event.payload?.impact;
  if (!Array.isArray(raw)) return null;
  const visible: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) visible.push(item);
    if (visible.length >= METHODOLOGY_BULLET_LIMIT) break;
  }
  if (visible.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
      {visible.map((bullet, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
          <span className="line-clamp-2">{bullet}</span>
        </li>
      ))}
    </ul>
  );
}

// Cause-of-death labels mirror `shared/types/cause-of-death.ts` enum values.
// Kept locally rather than importing the enum to avoid a runtime dep on
// stablecoin schema modules from the EventCard render path.
const CAUSE_OF_DEATH_LABELS: Record<string, string> = {
  "algorithmic-failure": "Algorithmic failure",
  "counterparty-failure": "Counterparty failure",
  "liquidity-drain": "Liquidity drain",
  "regulatory": "Regulatory",
  "abandoned": "Abandoned",
};

function CauseOfDeathPill({ cause }: { cause: string }) {
  const label = CAUSE_OF_DEATH_LABELS[cause] ?? cause;
  return (
    <span className="inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

const FREEZE_ACTION_LABEL: Record<string, string> = {
  "freeze.blocked": "frozen",
  "freeze.unblocked": "unfrozen",
  "freeze.destroyed": "destroyed",
};

function FreezeEnrichment({ event }: { event: TapeEvent }) {
  const amount = event.payload?.amountUsdAtEvent;
  if (typeof amount !== "number" || amount <= 0) return null;
  const action = FREEZE_ACTION_LABEL[event.type];
  if (!action) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-xs">
      <span className="inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground/80">
        {formatCompactUsd(amount)}
      </span>
      <span className="text-[11px] text-muted-foreground">{action}</span>
    </div>
  );
}

function CemeteryEnrichment({ event }: { event: TapeEvent }) {
  const cause = event.payload?.causeOfDeath;
  const peakMcap = event.payload?.peakMcap;
  const causeStr = typeof cause === "string" && cause.length > 0 ? cause : null;
  const peakNum = typeof peakMcap === "number" && peakMcap > 0 ? peakMcap : null;
  if (!causeStr && !peakNum) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      {causeStr ? <CauseOfDeathPill cause={causeStr} /> : null}
      {peakNum ? (
        <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span>Peak</span>
          <span className="text-foreground/80">{formatCompactUsd(peakNum)}</span>
        </span>
      ) : null}
    </div>
  );
}

function formatAbsoluteDay(value: string): string | null {
  const segments = value.split("-");
  const year = Number(segments[0]);
  const month = Number(segments[1] ?? "1");
  const day = Number(segments[2] ?? "1");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)));
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function LifecycleEnrichment({ event }: { event: TapeEvent }) {
  const cause = event.payload?.causeOfDeath;
  const frozenAt = event.payload?.frozenAt;
  const causeStr = typeof cause === "string" && cause.length > 0 ? cause : null;
  const frozenStr = typeof frozenAt === "string" && frozenAt.length > 0 ? formatAbsoluteDay(frozenAt) : null;
  if (!causeStr && !frozenStr) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      {causeStr ? <CauseOfDeathPill cause={causeStr} /> : null}
      {frozenStr ? (
        <span className="text-[11px] tabular-nums text-muted-foreground">Archived {frozenStr}</span>
      ) : null}
    </div>
  );
}

function EventCardEnrichment({ event }: { event: TapeEvent }) {
  switch (eventClass(event.type)) {
    case "depeg":       return <DepegEnrichment event={event} />;
    case "score":       return <ScoreEnrichment event={event} />;
    case "methodology": return <MethodologyEnrichment event={event} />;
    case "freeze":      return <FreezeEnrichment event={event} />;
    case "cemetery":    return <CemeteryEnrichment event={event} />;
    case "lifecycle":   return <LifecycleEnrichment event={event} />;
    case "psi":         return <BandTransitionEnrichment event={event} />;
    case "dews":        return <BandTransitionEnrichment event={event} />;
    case "mint_burn":   return <MintBurnFlowEnrichment event={event} />;
    case "yield":       return <YieldEnrichment event={event} />;
    default:            return null;
  }
}

interface EventCardProps {
  event: TapeEvent;
  /** Optional stablecoin logo lookup for `event.coinId`. */
  logoSrc?: string | undefined;
  /** Renders a focus ring + highlight when truthy. Used by `?event=` permalinks. */
  highlighted?: boolean;
  /** Optional id attribute for scroll-into-view targeting. */
  domId?: string;
  /** When >1, renders an `×N` badge to indicate collapsed sibling events. */
  count?: number;
}

export function EventCard({ event, logoSrc, highlighted = false, domId, count = 1 }: EventCardProps) {
  const severityLabel = SEVERITY_LABEL[event.severity];
  const severityText = SEVERITY_TEXT[event.severity];
  const href = event.sourceUrl ?? `/timeline/?event=${encodeURIComponent(event.id)}`;
  const titleId = `tape-event-${event.id}`;
  const ticker = deriveTicker(event);
  const rowTint = tapeClassRowBg(event.type);
  const chipTint = tapeClassChipBg(event.type);
  // For coin events the title is redundant with [ticker + type + enrichment];
  // for non-coin events (methodology, lifecycle without coin) the title is the
  // primary descriptive content and we surface it as the body line.
  const summaryLine = event.summary && event.summary.length > 0 ? event.summary : (!event.coinId ? event.title : "");
  const [copied, setCopied] = useState(false);
  const handleCopyPermalink = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window === "undefined" || !navigator.clipboard) return;
    const permalink = `${window.location.origin}/timeline/?event=${encodeURIComponent(event.id)}`;
    void navigator.clipboard.writeText(permalink).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [event.id]);

  return (
    <Link
      id={domId}
      href={href}
      aria-labelledby={titleId}
      data-event-id={event.id}
      className={`pharos-focus-ring group block border-b border-border/30 px-3 py-2 font-mono text-xs transition-colors hover:bg-muted/30 ${rowTint}${
        highlighted ? " bg-amber-500/5" : ""
      }`}
    >
      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap">
        <time
          dateTime={new Date(event.ts).toISOString()}
          title={formatAbsoluteDate(event.ts)}
          className="shrink-0 tabular-nums text-muted-foreground"
        >
          {formatHhMm(event.ts)}
        </time>
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
          {event.coinId ? (
            <StablecoinLogo src={logoSrc} name={event.coinId} size={22} />
          ) : (
            <span className={`inline-flex h-5 w-5 items-center justify-center rounded-sm ${chipTint}`}>
              <ClassIcon type={event.type} className="h-3.5 w-3.5" />
            </span>
          )}
        </span>
        <span id={titleId} className="sr-only">{event.title}</span>
        {ticker ? (
          <span aria-hidden="true" className="shrink-0 font-semibold text-foreground">{ticker}</span>
        ) : null}
        <span className="shrink-0 text-muted-foreground">{event.type}</span>
        <span className={`shrink-0 uppercase tracking-wide ${severityText}`} aria-label={`severity ${severityLabel}`}>
          {severityLabel}
        </span>
        {count > 1 ? (
          <span aria-label={`${count} similar events grouped`} className="shrink-0 tabular-nums text-muted-foreground">
            ×{count}
          </span>
        ) : null}
        {event.chain ? (
          <span className="shrink-0 uppercase tracking-wide text-muted-foreground">[{event.chain}]</span>
        ) : null}
        <span className="flex-1" aria-hidden="true" />
        <button
          type="button"
          onClick={handleCopyPermalink}
          aria-label={copied ? "Permalink copied" : "Copy permalink to this event"}
          className="pharos-focus-ring shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Link2 className="h-3 w-3" aria-hidden="true" />}
        </button>
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatRelativeTime(event.ts)}</span>
      </div>
      {summaryLine ? (
        <p className="mt-0.5 pl-[calc(5ch+2.75rem)] text-muted-foreground/80 line-clamp-2">
          {summaryLine}
        </p>
      ) : null}
      <div className="pl-[calc(5ch+2.75rem)]">
        <EventCardEnrichment event={event} />
      </div>
    </Link>
  );
}
