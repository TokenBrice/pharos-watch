"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule } from "@/components/stablecoin-detail/evidence-module";
import { cn } from "@/lib/utils";
import { getCoinOverride } from "@/components/stablecoin-detail/mechanism-diagrams/coin-overrides";
import { MechanismFlow } from "@/components/stablecoin-detail/mechanism-diagrams/mechanism-flow";
import {
  deriveLiquidationEngine,
  resolveMechanismFlowTemplate,
  resolveWrapperLayer,
} from "@/components/stablecoin-detail/mechanism-diagrams/mechanism-template";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import { getMechanismArchetypeCtaNoun, getMechanismExplainerPath } from "@shared/lib/classification";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import { findSummaryBudgetViolations, SUMMARY_PROSE_MAX_WORDS } from "@shared/lib/summary-budget";
import { deriveVerdictLine } from "@/components/stablecoin-detail/verdict-line";

const PROSE_CLASS = "text-pretty text-sm leading-relaxed";
const SUBHEADING_CLASS = "mb-1.5 text-xs font-semibold text-muted-foreground";

/**
 * The site's accessible link tone: frost-blue itself is about 2:1 on the light
 * card, so light mode takes the darker sky ramp step (≥ 5.5:1) and dark mode
 * keeps the brand frost.
 */
const LINK_TONE_CLASS = "text-sky-700 dark:text-frost-blue";

/** Closing marks that may follow a sentence's final stop, as in `(OKX).` or `etc.)`. */
const TRAILING_CLOSERS = /["'”’)\]]+$/;

/**
 * Curated prose is authored data and sometimes lacks its final stop (USDT's
 * peg text ends "…on 20+ additional chains"). The render closes the sentence
 * instead of printing a dangling clause; the data stays as authored.
 */
function closeSentence(text: string): string {
  const trimmed = text.trimEnd();
  const core = trimmed.replace(TRAILING_CLOSERS, "");
  return core === "" || /[.!?…:]$/.test(core) ? trimmed : `${trimmed}.`;
}

/**
 * Curated collateral / peg prose carries the summary-layer prose budget (40
 * words, no raw identifiers) rather than the 25-word verdict budget: within
 * budget it renders whole; past it, the first clean sentence stays visible
 * and the full text folds into the module's Review notes.
 */
function splitProse(text: string): { line: string | null; folded: string | null } {
  const closed = closeSentence(text);
  if (findSummaryBudgetViolations(closed, SUMMARY_PROSE_MAX_WORDS).length === 0) {
    return { line: closed, folded: null };
  }
  const line = deriveVerdictLine(closed, SUMMARY_PROSE_MAX_WORDS);
  return { line: line ? closeSentence(line) : null, folded: closed };
}

interface ReviewNote {
  label: string;
  text: string;
}

function ProseColumn({ heading, line, folded }: { heading: string; line: string | null; folded: boolean }) {
  return (
    <section>
      <h3 className={SUBHEADING_CLASS}>{heading}</h3>
      {line ? (
        <p className={PROSE_CLASS}>{line}</p>
      ) : folded ? (
        <p className={cn(PROSE_CLASS, "text-muted-foreground")}>Full text in Review notes.</p>
      ) : null}
    </section>
  );
}

/**
 * The (?) beside the module title, in the page's help-glyph grammar: it opens
 * a short primer (the diagram's own description) with the archetype explainer
 * link, rather than navigating away on click.
 */
function MechanismHint({ noun, primer, href }: { noun: string; primer: string; href: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Explain the ${noun} mechanism`}
          className="pharos-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-frost-blue/25 bg-frost-blue/10 text-sky-700 transition-colors hover:border-frost-blue/45 hover:bg-frost-blue/14 hover:text-foreground motion-reduce:transition-none md:h-6 md:w-6 dark:text-frost-blue"
        >
          <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[300px] border border-border/70 bg-popover px-3 py-3 text-popover-foreground shadow-xl">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-foreground">How {noun} stablecoins work</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{primer}</p>
          <Link
            href={href}
            className={cn(
              "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs font-medium underline-offset-4 hover:underline",
              LINK_TONE_CLASS,
            )}
          >
            Read the explainer
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface PegStabilityCardProps {
  meta: StablecoinDetailCoinMeta;
  resolvedMechanismArchetype?: MechanismArchetype | null;
  isWrapper: boolean;
  parentSymbol?: string | null;
  parentArchetype?: MechanismArchetype | null;
  /**
   * Parent coin's `flags.navToken`, for the wrapper's parent flow. The
   * wrapper's own flag cannot stand in for it: three of the four tracked
   * wrappers over a `tbill` parent are NAV tokens whose parent is not.
   */
  parentNavToken?: boolean | null;
  /**
   * Parent coin's `deriveLiquidationEngine` result, for the wrapper's parent
   * flow. The wrapper's own backing review cannot stand in for it: every
   * wrapper rules liquidation out locally.
   */
  parentLiquidationEngine?: boolean | null;
  variantKind?: StablecoinMeta["variantKind"] | null;
  /**
   * Reserves already draws a reviewed composition for this coin, so the
   * curated collateral paragraph folds instead of repeating it.
   */
  hasReviewedReserves?: boolean;
  /**
   * The coin's reviewed backing view. Its structural notes, with the oracle
   * role on `meta`, select the `cdp` reserve copy for designs without a
   * liquidation engine (see `deriveLiquidationEngine`).
   */
  mechanismBacking?: Pick<MechanismBackingView, "notes"> | null;
  /**
   * The dated mechanism review behind the Backing pillar's mechanism
   * components. Its notes and sources join the card's one provenance fold,
   * which then owns `#mechanism-review`, and its date stamps the footer.
   */
  mechanismReview?: MechanismReviewView | null;
}

/**
 * Mechanism module (`#mechanism`): the coin's resolved mechanism flow across
 * the full width, then the curated peg-mechanism and collateral prose in two
 * columns. It is the primer the Safety Score pillars assume, and the only
 * on-page render of `collateral` and `pegMechanism`.
 *
 * It shares the `EvidenceModule` shell: the help glyph sits right after the
 * title, and everything the summary layer cannot carry (over-budget prose,
 * the collateral note Reserves already draws, the mechanism review's notes
 * and sources) folds into one `Review notes & sources (N)` disclosure at the
 * end, in the `EvidenceFooter` grammar. With a mechanism review that fold
 * owns `#mechanism-review` and the footer reads `Reviewed <date>`.
 */
export function PegStabilityCard({
  meta,
  resolvedMechanismArchetype,
  isWrapper,
  parentSymbol,
  parentArchetype,
  parentNavToken,
  parentLiquidationEngine,
  variantKind,
  hasReviewedReserves = false,
  mechanismBacking = null,
  mechanismReview = null,
}: PegStabilityCardProps) {
  if (!meta.pegMechanism) return null;

  const effectiveArchetype =
    resolvedMechanismArchetype !== undefined ? resolvedMechanismArchetype : (meta.mechanismArchetype ?? null);
  const wrapper = isWrapper && parentArchetype && parentSymbol
    ? resolveWrapperLayer(meta.symbol, parentSymbol, variantKind)
    : null;
  // `flags.navToken` splits `tbill` between NAV-accreting fund shares and
  // $1-pegged reserve tokens; the schema defaults the flag, so an absent one
  // is a curated `false` rather than an unknown.
  const template = wrapper && parentArchetype
    ? resolveMechanismFlowTemplate(parentArchetype, wrapper.parentSymbol, {
        navToken: parentNavToken ?? null,
        liquidationEngine: parentLiquidationEngine ?? null,
      })
    : effectiveArchetype
      ? resolveMechanismFlowTemplate(
          effectiveArchetype,
          meta.symbol,
          {
            navToken: meta.flags?.navToken === true,
            liquidationEngine: deriveLiquidationEngine(mechanismBacking, meta.oracleRiskSummary?.role),
          },
          getCoinOverride(meta.id),
        )
      : null;
  const archetypeNoun = effectiveArchetype ? getMechanismArchetypeCtaNoun(effectiveArchetype) : null;
  const explainerPath = effectiveArchetype ? getMechanismExplainerPath(effectiveArchetype) : null;

  const notes: ReviewNote[] = [];
  const peg = splitProse(meta.pegMechanism);
  if (peg.folded) notes.push({ label: "Peg mechanism", text: peg.folded });

  let collateral: ReactNode = null;
  if (meta.collateral && hasReviewedReserves) {
    notes.push({ label: "Collateral", text: closeSentence(meta.collateral) });
    collateral = (
      <section>
        <h3 className={SUBHEADING_CLASS}>Collateral</h3>
        <p className={cn(PROSE_CLASS, "text-muted-foreground")}>
          Drawn as the reviewed composition in{" "}
          <a href="#reserves" className="pharos-prose-link">
            Reserves
          </a>
          .
        </p>
      </section>
    );
  } else if (meta.collateral) {
    const split = splitProse(meta.collateral);
    if (split.folded) notes.push({ label: "Collateral", text: split.folded });
    collateral = <ProseColumn heading="Collateral" line={split.line} folded={split.folded !== null} />;
  }

  // The mechanism review is this card's provenance: its notes join the fold,
  // its sources follow them, and its date is the card's only review date.
  if (mechanismReview) notes.push({ label: "Mechanism review", text: mechanismReview.notes });

  const visual = template ? (
    <MechanismFlow
      template={template}
      wrapper={wrapper}
      action={
        explainerPath && archetypeNoun ? (
          <Link
            href={explainerPath}
            className={cn(
              "pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs font-medium underline-offset-4 hover:underline sm:min-h-0 sm:py-0",
              LINK_TONE_CLASS,
            )}
          >
            Learn how {archetypeNoun} stablecoins work
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : null
      }
    />
  ) : (
    <div className="max-w-2xl space-y-1.5 rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
      <p className="text-sm font-semibold">Custom design — no archetype assigned</p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        This coin doesn&apos;t fit the tracked archetypes. See the description below and the{" "}
        <Link
          href="/methodology/"
          className={cn("pharos-focus-ring rounded-sm underline-offset-4 hover:underline", LINK_TONE_CLASS)}
        >
          methodology page
        </Link>{" "}
        for how Pharos scores it.
      </p>
    </div>
  );

  return (
    <EvidenceModule
      id="mechanism"
      title="Mechanism"
      variant="module"
      headingLevel="h2"
      methodology={
        template && archetypeNoun && explainerPath ? (
          <MechanismHint
            noun={archetypeNoun}
            primer={wrapper ? `${wrapper.ariaLabel} ${template.description}` : template.description}
            href={explainerPath}
          />
        ) : undefined
      }
      visual={visual}
      footer={
        <EvidenceFooter
          notes={
            notes.length > 0
              ? notes.map((note) => (
                  <section key={note.label} className="space-y-1">
                    <h4 className="font-semibold text-foreground">{note.label}</h4>
                    <p className="max-w-[75ch] whitespace-pre-line">{note.text}</p>
                  </section>
                ))
              : undefined
          }
          notesCount={notes.length > 0 ? notes.length : undefined}
          sources={mechanismReview?.sources}
          foldId={mechanismReview ? "mechanism-review" : undefined}
          reviewed={mechanismReview?.reviewedAt}
        />
      }
    >
      <div className="@container">
        <div
          className={cn(
            "grid gap-x-10 gap-y-5 border-t border-border/40 pt-5",
            collateral ? "@3xl:grid-cols-2" : undefined,
          )}
        >
          <ProseColumn heading="Peg mechanism" line={peg.line} folded={peg.folded !== null} />
          {collateral}
        </div>
      </div>
    </EvidenceModule>
  );
}
