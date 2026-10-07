"use client";

import { Fragment, type ReactNode } from "react";
import { Flame, Lock, LockOpen, ShieldQuestion, Snowflake, UserLock, type LucideIcon } from "lucide-react";
import { MethodologyHint } from "@/components/methodology-hint";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import {
  RailArrow,
  RailStationChip,
  StationLabel,
  type RailStationTone,
} from "@/components/stablecoin-detail/rail-station";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { Badge } from "@/components/ui/badge";
import { useBlacklistSummary } from "@/hooks/use-blacklist-events";
import { useNearViewport } from "@/hooks/use-near-viewport";
import type { MethodologyContextKey } from "@/lib/methodology-context";
import type {
  BlacklistabilityClientStatus,
  BlacklistabilityClientSummary,
} from "@/lib/stablecoin-detail-blacklistability-client";
import type { TransferReviewView } from "@/lib/transfer-review";
import { cn } from "@/lib/utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { formatCompactUsdShort } from "@shared/lib/format";
import type { BlacklistSummaryResponse } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

const METHODOLOGY_TOPIC: Record<BlacklistabilityClientStatus, MethodologyContextKey> = {
  freezable: "freezable",
  "not-freezable": "freezableNo",
  possible: "freezablePossible",
  inherited: "freezableUpstream",
};

/** Transfer-review scopes, home deployment first (the `buildTransferReviewView` order). */
const SCOPE_ORDER: Record<string, number> = { canonical: 0, "material-bridge": 1, additional: 2 };

/** Strictest posture first: a restricted copy is the finding, an open one the default. */
const POSTURE_ORDER: Record<string, number> = { permissioned: 0, restrictable: 1, permissionless: 2 };

/** Posture is geometry as well as words: open lock, lock, holder lock. */
const POSTURE_ICONS: Record<string, LucideIcon> = {
  permissionless: LockOpen,
  restrictable: Lock,
  permissioned: UserLock,
};

interface StationChip {
  key: string;
  content: ReactNode;
  icon?: LucideIcon;
  tone?: RailStationTone;
  title?: string;
}

interface Station {
  key: string;
  label: string;
  chips: StationChip[];
  /** Spoken form of the station for the rail's `aria-label`. */
  spoken: string;
}

interface ScopeGroup {
  key: string;
  scope: string;
  scopeLabel: string;
  posture: string;
  postureLabel: string;
  chains: string[];
}

/** One group per scope × posture pair; the chains behind each stay in its tooltip and the detail fold. */
function groupTransferScope(review: TransferReviewView): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const deployment of review.deployments) {
    const key = `${deployment.scope}:${deployment.posture}`;
    const group = groups.get(key);
    if (group) {
      group.chains.push(deployment.chainName);
      continue;
    }
    groups.set(key, {
      key,
      scope: deployment.scope,
      scopeLabel: deployment.scopeLabel,
      posture: deployment.posture,
      postureLabel: deployment.postureLabel,
      chains: [deployment.chainName],
    });
  }
  return [...groups.values()].sort((left, right) =>
    (SCOPE_ORDER[left.scope] ?? 9) - (SCOPE_ORDER[right.scope] ?? 9)
    || (POSTURE_ORDER[left.posture] ?? 9) - (POSTURE_ORDER[right.posture] ?? 9),
  );
}

function Figure({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/**
 * The power stations. `possible` is drawn as a dashed "Not established" chip:
 * a plausible path is neither a freeze power nor its absence. `inherited`
 * draws the upstream asset as its own station feeding the power, when the
 * parent is named.
 */
function buildPowerStations(summary: BlacklistabilityClientSummary): Station[] {
  switch (summary.status) {
    case "freezable":
      return [{
        key: "power",
        label: "Power",
        chips: [{ key: "power", content: "Freezable", icon: Snowflake }],
        spoken: "Freeze power: freezable",
      }];
    case "not-freezable":
      return [{
        key: "power",
        label: "Power",
        chips: [{ key: "power", content: "Not freezable", icon: LockOpen }],
        spoken: "Freeze power: not freezable",
      }];
    case "possible":
      return [{
        key: "power",
        label: "Power",
        chips: [{ key: "power", content: "Not established", icon: ShieldQuestion, tone: "unknown" }],
        spoken: "Freeze power: not established",
      }];
    case "inherited": {
      const power: Station = {
        key: "power",
        label: "Power",
        chips: [{ key: "power", content: "Inherited", icon: Snowflake }],
        spoken: summary.upstreamLabel
          ? `Freeze power: inherited from ${summary.upstreamLabel}`
          : "Freeze power: inherited from upstream assets",
      };
      if (!summary.upstreamLabel) return [power];
      return [
        {
          key: "upstream",
          label: "Upstream",
          chips: [{ key: "upstream", content: `via ${summary.upstreamLabel}`, title: summary.upstreamLabel }],
          spoken: `Upstream: ${summary.upstreamLabel}`,
        },
        power,
      ];
    }
  }
}

function buildScopeStation(review: TransferReviewView): Station {
  const groups = groupTransferScope(review);
  return {
    key: "scope",
    label: "Scope",
    chips: groups.map((group) => ({
      key: group.key,
      icon: POSTURE_ICONS[group.posture],
      title: group.chains.join(", "),
      content: (
        <>
          {group.scopeLabel} · {group.postureLabel}
          {group.chains.length > 1 ? (
            <span className="ml-1 text-muted-foreground">
              <Figure>×{group.chains.length}</Figure>
            </span>
          ) : null}
        </>
      ),
    })),
    spoken: `Transfer review: ${groups
      .map((group) =>
        `${group.chains.length} ${group.scopeLabel.toLowerCase()} ${group.chains.length === 1 ? "deployment" : "deployments"} ${group.postureLabel.toLowerCase()}`)
      .join(", ")}`,
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Observed use of the power, from the freeze tracker. Returns null when the
 * tracker publishes nothing usable for this coin: the station is omitted then,
 * never drawn as "0 frozen". Zero-valued figures drop out for the same reason
 * (a zero frozen total can mean "amounts unavailable"); a coin the tracker
 * watches with no recorded event reads "None recorded" in words.
 */
function buildUsedStation(stats: BlacklistSummaryResponse["stats"], symbol: string): Station | null {
  const events = finiteOrNull(stats.perCoinTotalEvents[symbol]);
  const addresses = finiteOrNull(stats.perCoinFrozenAddressCount[symbol]);
  const frozenUsd = finiteOrNull(stats.perCoinFrozenTotal[symbol]);
  const destroyedUsd = finiteOrNull(stats.perCoinDestroyedTotal[symbol]);

  if (events === 0) {
    return {
      key: "used",
      label: "Used",
      chips: [{ key: "none", content: "None recorded", tone: "terminal" }],
      spoken: "Used: no freeze recorded",
    };
  }

  const chips: StationChip[] = [];
  const spoken: string[] = [];
  if (addresses != null && addresses > 0) {
    const count = addresses.toLocaleString("en-US");
    chips.push({
      key: "addresses",
      icon: Snowflake,
      tone: "terminal",
      content: <><Figure>{count}</Figure> {addresses === 1 ? "address" : "addresses"}</>,
    });
    spoken.push(`${count} ${addresses === 1 ? "address" : "addresses"} frozen`);
  }
  if (frozenUsd != null && frozenUsd > 0) {
    const amount = formatCompactUsdShort(frozenUsd);
    chips.push({ key: "frozen", tone: "terminal", content: <><Figure>{amount}</Figure> frozen</> });
    spoken.push(`${amount} frozen`);
  }
  if (destroyedUsd != null && destroyedUsd > 0) {
    const amount = formatCompactUsdShort(destroyedUsd);
    chips.push({ key: "destroyed", icon: Flame, tone: "terminal", content: <><Figure>{amount}</Figure> destroyed</> });
    spoken.push(`${amount} destroyed`);
  }

  if (chips.length === 0) {
    // Events exist but nothing is held or destroyed now: every freeze was released.
    if (events != null && events > 0 && addresses === 0 && frozenUsd === 0) {
      return {
        key: "used",
        label: "Used",
        chips: [{ key: "released", content: "No active freezes", tone: "terminal" }],
        spoken: "Used: no active freezes",
      };
    }
    return null;
  }
  return { key: "used", label: "Used", chips, spoken: `Used: ${spoken.join(", ")}` };
}

/** Downward connector for the stacked (tile) layout; the strip layout uses `RailArrow`. */
function StationConnector() {
  return (
    <>
      <span aria-hidden="true" className="flex h-3 w-3 flex-col items-center @[35rem]/freeze:hidden">
        <span className="h-full w-px bg-border" />
        <span className="border-x-[3px] border-t-4 border-x-transparent border-t-border" />
      </span>
      <div className="hidden @[35rem]/freeze:flex @[35rem]/freeze:min-w-8 @[35rem]/freeze:flex-1">
        <RailArrow />
      </div>
    </>
  );
}

/**
 * Power → scope → used, drawn only from structured fields (design principle
 * 7): the reviewed status, the per-deployment transfer posture and the
 * tracker's usage figures. There is no actor station — who holds the power is
 * not a structured field.
 *
 * The rail queries its own width: stacked kicker-beside-chips rows in a tile
 * (~480 px), one left → right row from 35rem (the strip form).
 */
function FreezePowerRail({ stations }: { stations: readonly Station[] }) {
  return (
    <div className="@container/freeze">
      <div
        role="img"
        aria-label={`${stations.map((station) => station.spoken).join(". ")}.`}
        className="flex flex-col gap-1 @[35rem]/freeze:flex-row @[35rem]/freeze:items-center @[35rem]/freeze:gap-3"
      >
        {stations.map((station, index) => (
          <Fragment key={station.key}>
            {index > 0 ? <StationConnector /> : null}
            <div className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 @[35rem]/freeze:flex @[35rem]/freeze:flex-col @[35rem]/freeze:items-start @[35rem]/freeze:gap-0.5">
              <StationLabel>{station.label}</StationLabel>
              <span className="flex min-w-0 flex-wrap items-center gap-1 @[35rem]/freeze:flex-col @[35rem]/freeze:items-start">
                {station.chips.map((chip) => (
                  <RailStationChip key={chip.key} icon={chip.icon} tone={chip.tone} title={chip.title}>
                    {chip.content}
                  </RailStationChip>
                ))}
              </span>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export interface FreezeSeizureModuleProps {
  summary?: BlacklistabilityClientSummary | null;
  /** Per-deployment transfer review (`buildTransferReviewView`); omits the scope station when null. */
  transferReview?: TransferReviewView | null;
  /** Coin ticker; usage is read only for coins in `BLACKLIST_STABLECOINS`. */
  symbol: string;
  variant: EvidenceModuleVariant;
  stripForm?: boolean;
}

/**
 * Freeze & seizure, a Control-board tile (plan §5): whether the issuer can
 * freeze or seize holders' tokens, on which deployments the transfer review
 * found that power, and — for coins the freeze tracker watches — how much it
 * has been used. Observed events stay in the Activity section; this module
 * draws the power.
 *
 * Usage reads the same summary query as the Activity section (react-query
 * dedupes it). The fetch waits until the tile nears the viewport, the lane
 * gating the page applies to every offscreen query; cached data shows at once.
 */
export function FreezeSeizureModule({
  summary,
  transferReview = null,
  symbol,
  variant,
  stripForm,
}: FreezeSeizureModuleProps) {
  const tracked = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const { ref: usageGateRef, near } = useNearViewport<HTMLDivElement>("600px");
  const usageQuery = useBlacklistSummary({ enabled: tracked && near && summary != null });

  if (!summary) return null;

  const usageStats = tracked ? usageQuery.data?.stats : undefined;
  const usedStation = usageStats ? buildUsedStation(usageStats, symbol) : null;
  const stations = [
    ...buildPowerStations(summary),
    ...(transferReview && transferReview.deployments.length > 0 ? [buildScopeStation(transferReview)] : []),
    ...(usedStation ? [usedStation] : []),
  ];

  // The merged provenance fold always carries the source question: with no
  // cited source it says so first-hand, with the review's rationale when one
  // exists, instead of the fold silently dropping its "sources" half.
  const hasSources = summary.sources.length > 0;
  const notes = (
    <>
      <p>{summary.evidence}</p>
      {hasSources ? (
        summary.sourceFreeRationale ? <p>{summary.sourceFreeRationale}</p> : null
      ) : (
        <p>
          <span className="font-medium text-foreground">No public source.</span>{" "}
          {summary.sourceFreeRationale ?? "The review cites no source document."}
        </p>
      )}
    </>
  );
  const notesCount = 1 + (!hasSources || summary.sourceFreeRationale ? 1 : 0);

  return (
    <EvidenceModule
      id="freeze-seizure"
      title="Freeze & seizure"
      variant={variant}
      stripForm={stripForm}
      methodology={<MethodologyHint topic={METHODOLOGY_TOPIC[summary.status]} />}
      headerRight={
        <Badge variant="outline" className={cn("text-[11px] font-medium", summary.statusToneClass)}>
          {summary.statusLabel}
        </Badge>
      }
      visual={
        <div ref={tracked ? usageGateRef : undefined}>
          <FreezePowerRail stations={stations} />
        </div>
      }
      verdict={summary.statusNote}
      chipRow={
        <Badge
          variant="outline"
          className={cn(
            "text-[11px] font-normal text-muted-foreground",
            summary.sources.length === 0 && "border-dashed",
          )}
        >
          {summary.basisLabel}
        </Badge>
      }
      footer={
        <EvidenceFooter
          foldId="freeze-seizure-notes"
          notes={notes}
          notesCount={notesCount}
          sources={summary.sources.map((source) => ({ label: source.label, url: source.url }))}
          reviewed={summary.reviewedAt ?? undefined}
        >
          {usedStation ? (
            <FreshnessIndicator
              compact
              updatedAtMs={usageQuery.dataUpdatedAt}
              staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.blacklistSummary * 1000}
              labelPrefix="Usage updated"
            />
          ) : null}
        </EvidenceFooter>
      }
    >
      {transferReview && transferReview.deployments.length > 0 ? (
        <ModuleDisclosure label="Reviewed deployments" count={transferReview.deployments.length}>
          <div className="mt-2 space-y-2 pb-1 text-xs">
            <ul className="divide-y divide-border/40">
              {transferReview.deployments.map((deployment) => (
                <li key={deployment.key} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate text-foreground">{deployment.chainName}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {deployment.scopeLabel} · {deployment.postureLabel}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">Transfer posture reviewed {transferReview.reviewedAt}.</p>
          </div>
        </ModuleDisclosure>
      ) : null}
    </EvidenceModule>
  );
}
