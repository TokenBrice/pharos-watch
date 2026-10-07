"use client";

import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleSlash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailArrow, RailStation } from "@/components/stablecoin-detail/rail-station";
import { ScoreBandSpectrum } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { DETAIL_MODULE_TITLE_CLASS, SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import type { ControlComponentRoles, ControlStripComponent, PillarStripTone } from "@/lib/pillar-evidence-strips";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  formatOraclePct,
  oracleTierLabel,
  resolveOracleTierLadder,
  type OracleBranchClientRow,
  type OracleRiskClientSummary,
} from "@/lib/stablecoin-detail-oracle-client";
import { cn } from "@/lib/utils";
import type { OracleRiskRole, OracleRiskTier } from "@shared/types";

/** Branch rows beyond this count move into the disclosure, sorted forward. */
const INLINE_BRANCH_LIMIT = 5;
/** Source chips beyond this count collapse into one "+N more" chip. */
const SOURCE_CHIP_LIMIT = 3;

/** Who reads the reviewed price: the station at the end of the price path. */
const CONSUMER_LABELS: Record<OracleRiskRole, string> = {
  "collateral-pricing": "Liquidation engine",
  "coin-price-feed": "Mint / redeem quote",
};

/** Restrained score-pill tint, as on the Control strip: neutral unless the input is the problem. */
const SCORE_PILL_TONE_CLASS: Record<PillarStripTone, string> = {
  neutral: SEVERITY_TONE_CLASS.neutral.pill,
  warn: SEVERITY_TONE_CLASS.watch.pill,
  critical: SEVERITY_TONE_CLASS.alert.pill,
};

/**
 * Per-branch tier tags, colour on weak only (the Control strip grammar): the
 * watch tiers tint amber, an undisclosed tier is dashed like any unknown, and
 * every other tier stays neutral so a column of identical tags reads quietly.
 */
const BRANCH_TIER_TAG_CLASS: Record<OracleRiskTier, string> = {
  "oracleless": SEVERITY_TONE_CLASS.neutral.pill,
  "privileged-internal-pricing": SEVERITY_TONE_CLASS.watch.pill,
  "redundant-with-failover": SEVERITY_TONE_CLASS.neutral.pill,
  "medianized-with-delay": SEVERITY_TONE_CLASS.neutral.pill,
  "standard-external": SEVERITY_TONE_CLASS.neutral.pill,
  "single-source-or-laggy": SEVERITY_TONE_CLASS.watch.pill,
  "opaque-or-unknown": "border-dashed border-muted-foreground/50 text-muted-foreground",
};

/** Which collateral figure the branch table prints, by what the review records. */
type BranchRatioColumn = "min-cr" | "max-ltv";

const BRANCH_RATIO_LABELS: Record<BranchRatioColumn, string> = {
  "min-cr": "Min CR",
  "max-ltv": "Max LTV",
};

/**
 * Wide branch-table tracks (container ≥ 42rem), keyed by which optional
 * columns exist: branch · tier · [share of debt] · [ratio]. Static strings.
 */
const BRANCH_TABLE_TRACKS_CLASS: Record<"share-ratio" | "share" | "ratio" | "none", string> = {
  "share-ratio": "@2xl/branches:grid-cols-[minmax(0,1.4fr)_auto_minmax(8rem,1fr)_auto]",
  share: "@2xl/branches:grid-cols-[minmax(0,1.4fr)_auto_minmax(8rem,1fr)]",
  ratio: "@2xl/branches:grid-cols-[minmax(0,1fr)_auto_auto]",
  none: "@2xl/branches:grid-cols-[minmax(0,1fr)_auto]",
};

const SUBLABEL_CLASS = "text-[11px] font-medium uppercase leading-tight tracking-[0.12em] text-muted-foreground";
/** `wrap-anywhere`: contract addresses in feed paths break instead of spilling on phones. */
const DETAIL_LINE_CLASS = "text-xs leading-relaxed text-muted-foreground wrap-anywhere";
/**
 * Reading width for the branch table and the facts in a full-width module: at
 * 1920 the body is ~1,440 px, which would put a branch name ~1,000 px from its
 * tier tag and spread four facts across the whole row.
 */
const READING_WIDTH_CLASS = "max-w-[52rem]";

/**
 * Full width for multi-branch collateral pricing (the branch table needs the
 * room); every other review is a tile.
 */
export function oracleModuleSize(summary: Pick<OracleRiskClientSummary, "branchCount">): "module" | "tile" {
  return summary.branchCount >= 2 ? "module" : "tile";
}

function branchHasDetail(branch: OracleBranchClientRow): boolean {
  return (
    branch.collateralParameters.length > 0 ||
    branch.liquidationMechanism != null ||
    branch.liquidationDelayLabel != null ||
    branch.backstop != null ||
    branch.fallbackBehavior != null ||
    branch.shutdownOrBadDebtBehavior != null
  );
}

/**
 * Highest debt-share branches first (null shares — unmeasured, so treated as
 * material — sort last), preserving the curated order otherwise. Coins with
 * many branches (up to ~40) need this so the inline rows are the ones that
 * matter most; the projection itself stays in curated order since the
 * disclosure detail below still walks every branch in that order.
 */
export function sortOracleBranchesForDisplay(branches: readonly OracleBranchClientRow[]): OracleBranchClientRow[] {
  return branches
    .map((branch, index) => ({ branch, index }))
    .sort((a, b) => {
      if (a.branch.debtSharePct == null && b.branch.debtSharePct == null) return a.index - b.index;
      if (a.branch.debtSharePct == null) return 1;
      if (b.branch.debtSharePct == null) return -1;
      if (a.branch.debtSharePct !== b.branch.debtSharePct) return b.branch.debtSharePct - a.branch.debtSharePct;
      return a.index - b.index;
    })
    .map(({ branch }) => branch);
}

/**
 * A branch's reviewed ratio across its collateral assets: one figure, or the
 * low–high range when its assets differ. Null when the review records none.
 */
function formatBranchRatio(branch: OracleBranchClientRow, column: BranchRatioColumn): string | null {
  const values = branch.collateralParameters
    .map((parameter) => (column === "min-cr" ? parameter.minCrPct : parameter.maxLtvPct))
    .filter((value): value is number => value != null);
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? formatOraclePct(low) : `${Number(low.toFixed(2))}–${formatOraclePct(high)}`;
}

/**
 * The published Control component's score, then its role tag: "Limiting
 * input" only at the eligible minimum, "Diagnostic" outside the eligible set.
 * Without a scored component the review's own tier chip stands in; a review
 * that rules the oracle not applicable shows neither (its body says so).
 */
function renderOracleHeaderStatus(
  summary: OracleRiskClientSummary,
  component: ControlStripComponent | null,
): ReactNode {
  if (component != null && component.score !== null) {
    const score = Math.round(component.score);
    return (
      <>
        <span className="sr-only">Oracle component score</span>
        <ScorePill
          label={String(score)}
          toneClass={SCORE_PILL_TONE_CLASS[component.tone]}
          title={`Oracle component of the Control pillar: ${score} of 100 for ${oracleTierLabel(component.posture)}.`}
        />
        <ControlRoleTag role={component.role} />
      </>
    );
  }
  if (summary.notApplicable) return null;
  return (
    <Badge variant="outline" className={cn("text-[11px] font-medium", summary.tierToneClass)}>
      {summary.tierLabel}
    </Badge>
  );
}

/**
 * Sources → aggregator → consumer. Sources are the reviewed feed providers
 * (an empty list is a dashed "Undisclosed" station, never a blank chip), the
 * aggregator is the reviewed pricing tier, and the consumer follows the role.
 *
 * The rail reads its own width (`@container/rail`): in a ~480 px tile the
 * stations stack top to bottom with downward arrows, and from 36rem they run
 * left to right. Station names wrap rather than truncate, so nothing clips.
 */
function OraclePricePath({
  summary,
  tierLabel,
  opaque,
}: {
  summary: OracleRiskClientSummary;
  /** The tier the ladder lights, so path and ladder never disagree. */
  tierLabel: string;
  opaque: boolean;
}) {
  const { providers } = summary;
  const hiddenProviders = providers.length - SOURCE_CHIP_LIMIT;
  const sourceChips = hiddenProviders > 0
    ? [...providers.slice(0, SOURCE_CHIP_LIMIT), `+${hiddenProviders} more`]
    : providers;
  const consumer = CONSUMER_LABELS[summary.role];
  const caption = [
    summary.feedCount > 0 ? `${summary.feedCount} ${summary.feedCount === 1 ? "feed" : "feeds"}` : null,
    summary.branchCount > 1 ? `${summary.branchCount} branches` : null,
  ].filter((part): part is string => part != null).join(" · ");
  const sourcesText = providers.length > 0 ? `sources ${providers.join(", ")}` : "sources undisclosed";

  return (
    <div
      role="img"
      aria-label={`Price path: ${sourcesText}; aggregated as ${tierLabel}${caption ? ` (${caption})` : ""}; read by the ${consumer.toLowerCase()}.`}
      // Source names can carry a contract address ("Vault source 0x1526…"):
      // one unbroken token that must wrap inside a 390 px chip, not spill.
      className="@container/rail [&_span]:wrap-anywhere"
    >
      <div className="flex flex-col gap-1 @xl/rail:flex-row @xl/rail:items-start @xl/rail:gap-3">
        <RailStation
          label="Sources"
          value={providers.length > 0 ? sourceChips : "Undisclosed"}
          tone={providers.length > 0 ? "default" : "unknown"}
          title={providers.length > 0 ? providers.join(", ") : undefined}
          wrap
          className="@xl/rail:max-w-[40%]"
        />
        <RailArrow orientation="container" />
        <RailStation
          label="Aggregator"
          value={tierLabel}
          tone={opaque ? "unknown" : "default"}
          caption={caption || null}
          wrap
        />
        <RailArrow orientation="container" />
        <RailStation label="Consumer" value={consumer} tone="terminal" wrap />
      </div>
    </div>
  );
}

/**
 * Branches as a table that reads its own width (`@container/branches`):
 * from 42rem one aligned row per branch (name · tier tag · debt-share bar ·
 * ratio) under a column header; narrower, each branch stacks name and ratio,
 * then its tier tag, then its share bar. Every branch carries its tier tag.
 * An unmeasured share is a dashed outline and "–", never an empty solid bar.
 */
function OracleBranchTable({
  branches,
  label,
  sharesMeasured,
  ratioColumn,
}: {
  branches: readonly OracleBranchClientRow[];
  label: string;
  /** False when no branch has a measured share: the share column is dropped. */
  sharesMeasured: boolean;
  ratioColumn: BranchRatioColumn | null;
}) {
  const tracks = BRANCH_TABLE_TRACKS_CLASS[
    sharesMeasured ? (ratioColumn ? "share-ratio" : "share") : ratioColumn ? "ratio" : "none"
  ];
  const ratioLabel = ratioColumn ? BRANCH_RATIO_LABELS[ratioColumn] : null;

  return (
    <div className="@container/branches">
      <div className={cn("@2xl/branches:grid @2xl/branches:gap-x-6", tracks)}>
        <div
          aria-hidden="true"
          className="hidden border-b border-border/60 pb-1.5 text-[11px] leading-tight text-muted-foreground @2xl/branches:col-span-full @2xl/branches:grid @2xl/branches:grid-cols-subgrid"
        >
          <span>Branch</span>
          <span>Pricing tier</span>
          {sharesMeasured ? <span>Share of debt</span> : null}
          {ratioLabel ? <span className="text-right">{ratioLabel}</span> : null}
        </div>
        <ul
          aria-label={label}
          className="divide-y divide-border/40 @2xl/branches:col-span-full @2xl/branches:grid @2xl/branches:grid-cols-subgrid"
        >
          {branches.map((branch) => {
            const share = branch.debtSharePct;
            const ratio = ratioColumn ? formatBranchRatio(branch, ratioColumn) : null;
            return (
              <li
                key={branch.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 py-2.5 @2xl/branches:col-span-full @2xl/branches:grid-cols-subgrid @2xl/branches:items-center @2xl/branches:gap-x-6"
              >
                <span className="col-start-1 row-start-1 text-sm font-medium leading-snug text-pretty text-foreground wrap-anywhere @2xl/branches:col-auto @2xl/branches:row-auto">
                  {branch.label}
                </span>
                <span className="col-span-2 col-start-1 row-start-2 @2xl/branches:col-auto @2xl/branches:row-auto">
                  <span
                    className={cn(
                      "inline-flex w-fit items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-tight",
                      BRANCH_TIER_TAG_CLASS[branch.tier],
                    )}
                  >
                    <span className="sr-only">Pricing tier: </span>
                    {branch.tierLabel}
                  </span>
                </span>
                {sharesMeasured ? (
                  <span className="col-span-2 col-start-1 row-start-3 flex items-center gap-2.5 @2xl/branches:col-auto @2xl/branches:row-auto">
                    {share != null ? (
                      <>
                        <span aria-hidden="true" className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-foreground/45"
                            style={{ width: `${Math.max(0, Math.min(100, share))}%` }}
                          />
                        </span>
                        <span className="min-w-14 shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums text-foreground">
                          {formatOraclePct(share)}
                          <span className="font-sans text-muted-foreground @2xl/branches:sr-only"> of debt</span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span
                          aria-hidden="true"
                          className="h-1.5 min-w-0 flex-1 rounded-full border border-dashed border-muted-foreground/50"
                        />
                        <span className="min-w-14 shrink-0 text-right font-mono text-xs text-muted-foreground" title="Debt share not measured">
                          <span aria-hidden="true">–</span>
                          <span className="sr-only">debt share not measured</span>
                        </span>
                      </>
                    )}
                  </span>
                ) : null}
                {ratioLabel ? (
                  <span className="col-start-2 row-start-1 justify-self-end whitespace-nowrap text-right font-mono text-xs tabular-nums text-foreground @2xl/branches:col-auto @2xl/branches:row-auto">
                    <span className="font-sans text-[11px] text-muted-foreground @2xl/branches:sr-only">{ratioLabel} </span>
                    {ratio ?? (
                      <>
                        <span aria-hidden="true" className="text-muted-foreground">–</span>
                        <span className="sr-only">not reviewed</span>
                      </>
                    )}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function BranchDetail({ branch }: { branch: OracleBranchClientRow }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-foreground">{branch.label}</h4>
      {branch.collateralParameters.map((parameter) => (
        <p key={parameter.key} className={DETAIL_LINE_CLASS}>
          <span className="font-medium text-foreground">{parameter.asset}</span>
          {parameter.maxLtvLabel ? ` · max LTV ${parameter.maxLtvLabel}` : ""}
          {parameter.minCrLabel ? ` · MCR ${parameter.minCrLabel}` : ""}
          {parameter.shutdownCrLabel ? ` · shutdown CR ${parameter.shutdownCrLabel}` : ""}
          {parameter.note ? ` · ${parameter.note}` : ""}
        </p>
      ))}
      {branch.liquidationMechanism ? (
        <p className={DETAIL_LINE_CLASS}>
          {branch.liquidationMechanism}
          {branch.liquidationDelayLabel != null ? ` · liquidation delay ${branch.liquidationDelayLabel}` : ""}
        </p>
      ) : branch.liquidationDelayLabel != null ? (
        <p className={DETAIL_LINE_CLASS}>{`Liquidation delay ${branch.liquidationDelayLabel}`}</p>
      ) : null}
      {branch.backstop ? <p className={DETAIL_LINE_CLASS}>{branch.backstop}</p> : null}
      {branch.fallbackBehavior ? <p className={DETAIL_LINE_CLASS}>{branch.fallbackBehavior}</p> : null}
      {branch.shutdownOrBadDebtBehavior ? <p className={DETAIL_LINE_CLASS}>{branch.shutdownOrBadDebtBehavior}</p> : null}
    </div>
  );
}

/**
 * What prices the coin or its collateral, and what reads that price: the
 * reviewed `oracleRisk` profile as a Control-pillar evidence module (plan §5,
 * §6). The visual stacks, each part at the full body width: the tier's place
 * on the published `oracleTierQuality` ladder, the sources → aggregator →
 * consumer price path, and for multi-branch collateral pricing a branch table
 * (tier tag, debt-share bar and collateral ratio per branch). Each part reads
 * its own container width, so a ~480 px tile, a strip and a full-width module
 * all lay out without clipping. The header carries the published oracle
 * component score and its role in the Control minimum.
 *
 * Renders nothing without a review. A review that rules the oracle not
 * applicable has nothing to draw, so it is one S14 line (decision S14):
 * "<Title> · Not applicable · <reason>" with its provenance fold and review
 * date on the same row, and the reviewer's rationale inside the fold.
 */
export function OracleLiquidationSection({
  summary,
  controlRoles,
  variant,
  stripForm = false,
}: {
  summary?: OracleRiskClientSummary | null;
  /** `resolveControlComponentRoles(reportCard)`; the oracle component drives the score pill and role tag. */
  controlRoles?: ControlComponentRoles | null;
  /** Defaults to `oracleModuleSize(summary)`. */
  variant?: EvidenceModuleVariant;
  stripForm?: boolean;
}) {
  if (!summary) return null;

  const component = controlRoles?.components.find((entry) => entry.kind === "oracle") ?? null;
  const headerRight = renderOracleHeaderStatus(summary, component);
  const layout = variant ?? oracleModuleSize(summary);
  const sources = summary.sources.map((source) => ({ label: source.label, url: source.url }));
  const reviewed = summary.reviewedAt ?? undefined;

  if (summary.notApplicable) {
    const notes = [summary.notApplicableRationale, summary.summary].filter(
      (note, index, all): note is string => note != null && all.indexOf(note) === index,
    );
    const reason = `${summary.tierLabel.charAt(0).toLowerCase()}${summary.tierLabel.slice(1)}`;
    return (
      <section
        id="oracle"
        aria-labelledby="oracle-title"
        data-evidence-state="not-applicable"
        className={cn("col-span-full rounded-xl border border-dashed border-border", SECTION_SCROLL_MT)}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <CircleSlash aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <h3 id="oracle-title" className={DETAIL_MODULE_TITLE_CLASS}>
              {summary.title}
            </h3>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className="text-sm text-muted-foreground">Not applicable</span>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className="min-w-0 text-xs leading-snug text-muted-foreground">{reason}</span>
          </div>
          <EvidenceFooter
            inline
            foldId="oracle-review-notes"
            notes={notes.map((note) => (
              <p key={note} className="whitespace-pre-line">{note}</p>
            ))}
            notesCount={notes.length}
            sources={sources}
            reviewed={reviewed}
            // An opened fold takes the whole strip width below the state line.
            className="min-w-0 flex-1 has-open:basis-full"
          />
        </div>
      </section>
    );
  }

  // The ladder sits beside the score pill, so it lights the scored posture
  // when the card publishes one; otherwise the review's own tier.
  const scoredTier = component != null && component.score !== null ? component.posture : summary.tier;
  const scoredLadder = resolveOracleTierLadder(scoredTier);
  const ladderTier = scoredLadder ? scoredTier : summary.tier;
  const ladder = scoredLadder ?? resolveOracleTierLadder(summary.tier);
  const tierLabel = oracleTierLabel(ladderTier);

  const sortedBranches = sortOracleBranchesForDisplay(summary.branches);
  const showBranches = sortedBranches.length >= 2;
  const inlineBranches = showBranches ? sortedBranches.slice(0, INLINE_BRANCH_LIMIT) : [];
  const overflowBranches = showBranches ? sortedBranches.slice(INLINE_BRANCH_LIMIT) : [];
  const sharesMeasured = summary.branches.some((branch) => branch.debtSharePct != null);
  // Min CR is the CDP figure; lending-market branches often review only Max LTV.
  const parameters = summary.branches.flatMap((branch) => branch.collateralParameters);
  const ratioColumn: BranchRatioColumn | null = parameters.some((parameter) => parameter.minCrPct != null)
    ? "min-cr"
    : parameters.some((parameter) => parameter.maxLtvPct != null)
      ? "max-ltv"
      : null;
  const detailBranches = summary.branches.filter(branchHasDetail);

  // Four facts at most; feed count and confidence live in the price path and
  // the chip row. The oracle's own price delay and the liquidation delay are
  // separate facts: "behind a price delay" never reads against "none".
  const facts: FactGridItem[] = [
    ...(summary.worstMaxLtvPct != null
      ? [{ key: "max-ltv", label: "Max LTV", value: formatOraclePct(summary.worstMaxLtvPct) }]
      : []),
    ...(summary.worstMinCrPct != null
      ? [{ key: "min-cr", label: "Min CR", value: formatOraclePct(summary.worstMinCrPct) }]
      : []),
    ...(summary.priceDelayLabel != null
      ? [{
          key: "price-delay",
          label: "Price delay",
          value: summary.priceDelayLabel,
          title: "The oracle holds each new price for a delay before it is used. This is separate from the liquidation delay.",
        }]
      : []),
    ...(summary.maxLiquidationDelayLabel != null
      ? [{
          key: "liq-delay",
          label: "Liquidation delay",
          value: summary.maxLiquidationDelayLabel,
          title: "The wait between a position becoming unsafe and its liquidation.",
        }]
      : []),
  ];

  const branchNotes = summary.branches.map((branch) => (
    <li key={branch.id}>
      <span className="font-medium text-foreground">{branch.label}</span>: {branch.summary}
    </li>
  ));

  const ladderNode = ladder ? (
    <ScoreBandSpectrum
      mode="ordinal"
      bands={ladder.bands}
      activeKey={ladder.activeKey}
      ariaLabel={`Oracle tier ${tierLabel}: band ${ladder.position} of ${ladder.bands.length} in the published oracle tier order, weakest to strongest${
        ladder.tiedTierLabels.length > 0 ? `; it shares its band with ${ladder.tiedTierLabels.join(" and ")}` : ""
      }.`}
    />
  ) : null;
  // Oracleless pricing has no feed path to draw; the ladder says it all.
  const pathNode = ladderTier !== "oracleless" ? (
    <OraclePricePath summary={summary} tierLabel={tierLabel} opaque={ladderTier === "opaque-or-unknown"} />
  ) : null;

  const branchesNode = showBranches ? (
    <div className={cn("space-y-2", READING_WIDTH_CLASS)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className={SUBLABEL_CLASS}>{sharesMeasured ? "Debt by branch" : "Branches"}</h4>
        <span className="text-[11px] leading-tight text-muted-foreground">
          {overflowBranches.length > 0
            ? `${sharesMeasured ? "Largest" : "First"} ${inlineBranches.length} of ${sortedBranches.length}`
            : `${sortedBranches.length} branches`}
          {sharesMeasured ? "" : " · debt shares not measured"}
        </span>
      </div>
      <OracleBranchTable
        branches={inlineBranches}
        label="Oracle branches"
        sharesMeasured={sharesMeasured}
        ratioColumn={ratioColumn}
      />
      {overflowBranches.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          + {overflowBranches.length} more {overflowBranches.length === 1 ? "branch" : "branches"} under Feeds,
          parameters & failure behavior
        </p>
      ) : null}
    </div>
  ) : null;

  const confidence = summary.confidenceLabel;

  return (
    <EvidenceModule
      id="oracle"
      title={summary.title}
      variant={layout}
      stripForm={stripForm}
      headerRight={headerRight}
      visual={
        <div className="space-y-5">
          {ladderNode}
          {pathNode}
          {branchesNode}
        </div>
      }
      verdict={summary.verdict}
      chipRow={
        confidence ? (
          <Badge
            variant="outline"
            className="border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground"
          >
            {confidence === "Verified" ? <CircleCheck aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
            Confidence: {confidence}
          </Badge>
        ) : null
      }
      folds={
        summary.feeds.length > 0 || overflowBranches.length > 0 || detailBranches.length > 0 ? (
          <ModuleDisclosure id="oracle-feeds" label="Feeds, parameters & failure behavior">
            <div className="mt-3 space-y-4">
              {summary.feeds.length > 0 ? (
                <div className="space-y-1.5">
                  <h4 className="text-xs font-medium text-foreground">Feeds</h4>
                  <ul aria-label="Price feeds" className="space-y-1.5">
                    {summary.feeds.map((feed, index) => (
                      <li key={`${index}:${feed.key}`} className={DETAIL_LINE_CLASS}>
                        <span className="font-medium text-foreground">{feed.path}</span>
                        {` · ${feed.provider} · ${feed.chainLabel}`}
                        {feed.heartbeatLabel ? ` · ${feed.heartbeatLabel} heartbeat` : ""}
                        {feed.stalenessLabel ? ` · ${feed.stalenessLabel} staleness bound` : ""}
                        {feed.branchLabels.length > 1 ? ` · read by ${feed.branchLabels.length} branches` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {overflowBranches.length > 0 ? (
                <OracleBranchTable
                  branches={overflowBranches}
                  label="Additional oracle branches"
                  sharesMeasured={sharesMeasured}
                  ratioColumn={ratioColumn}
                />
              ) : null}
              {detailBranches.map((branch) => (
                <BranchDetail key={branch.id} branch={branch} />
              ))}
            </div>
          </ModuleDisclosure>
        ) : null
      }
      footer={
        <EvidenceFooter
          foldId="oracle-review-notes"
          notes={
            <>
              <p className="whitespace-pre-line">{summary.summary}</p>
              {branchNotes.length > 0 ? (
                <ul aria-label="Branch review notes" className="space-y-2">
                  {branchNotes}
                </ul>
              ) : null}
            </>
          }
          notesCount={1 + branchNotes.length}
          sources={sources}
          reviewed={reviewed}
        />
      }
    >
      {facts.length > 0 ? (
        <FactGrid aria-label={`${summary.title} facts`} items={facts} className={READING_WIDTH_CLASS} />
      ) : null}
    </EvidenceModule>
  );
}
