"use client";

import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, CircleDashed, CircleSlash } from "lucide-react";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { MODULE_FOLD_RHYTHM_CLASS, ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

/**
 * DOM contract shared with `anchor-reveal.ts`:
 *
 * - Every `EvidenceModule` root is a `<section data-evidence-module="<layout>">`.
 * - A module that can fold below `md` also carries `data-expanded="true|false"`.
 *   The collapsed body is hidden by CSS keyed on that attribute (below `md`
 *   only), so flipping it reveals the body synchronously, before React
 *   re-renders. Modules that never fold carry no `data-expanded`.
 */
const EVIDENCE_MODULE_SELECTOR = "[data-evidence-module]";
const EXPANDED_ATTRIBUTE = "data-expanded";
const EXPAND_EVENT = "pharos:evidence-module-expand";

/** Matches Tailwind's `md` breakpoint (48rem): the whole-module fold stops here. */
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Expands the `EvidenceModule` that contains `target` (or is `target`). Call it
 * before scrolling to a hash target: below `md` the module may be folded, and
 * a target inside a `display: none` body has no position to scroll to.
 *
 * The reveal is synchronous (attribute flip); the event then syncs the
 * component's own state so its toggle keeps telling the truth. A no-op for
 * targets outside any module and for modules that never fold.
 */
export function expandEvidenceModuleFor(target: HTMLElement | null): void {
  const root = target?.closest<HTMLElement>(EVIDENCE_MODULE_SELECTOR);
  if (!root || root.getAttribute(EXPANDED_ATTRIBUTE) !== "false") return;
  root.setAttribute(EXPANDED_ATTRIBUTE, "true");
  root.dispatchEvent(new Event(EXPAND_EVENT));
}

export type EvidenceModuleVariant = "module" | "tile" | "strip";

/**
 * - `stack`: one column in the canonical order.
 * - `split`: once the module is wide enough, the summary layer splits:
 *   `visual` takes the left column and verdict, chips and summary children
 *   (facts, current-state callouts) the right one. The folds and the footer
 *   always run full width underneath. Below that width it stacks like `stack`.
 */
export type EvidenceModuleBodyLayout = "stack" | "split";

export interface EvidenceModuleProps {
  /** Anchor id on the `<section>`; hash targets on it or inside it unfold the module. */
  id?: string;
  title: string;
  /**
   * - `module`: full width of the column, e.g. Mint Authority or Redemption.
   * - `tile`: one track of the pillar tile grid (~480 px).
   * - `strip`: a compact band spanning the whole grid row, for a lone last
   *   tile or a module whose visual degraded. Same one-row header as a tile;
   *   the body splits into two columns when the band is wide enough.
   */
  variant: EvidenceModuleVariant;
  /** Renders the strip layout regardless of `variant` (a lone last tile). */
  stripForm?: boolean;
  /** `h3` inside a pillar board (group kicker is `h2`); `h2` only outside a board. */
  headingLevel?: "h2" | "h3";
  /**
   * Help glyph beside the title, e.g. `<MethodologyHint topic=… />`. Rendered
   * outside the heading so the mobile accordion button never nests a control.
   */
  methodology?: ReactNode;
  /**
   * One score pill **or** one status chip, then an optional ops chip. Status
   * only. Pass the chips as one fragment so the shell can tell the primary
   * chip (the first) from the rest. No chip is ever shrunk or ellipsized: at
   * `md+` the slot sits beside the title and wraps under it when both do not
   * fit; below `md` it always takes its own row under the title, and a folded
   * tile or strip shows the primary chip only.
   */
  headerRight?: ReactNode;
  /** The required visual summary: spectrum, rail, bar, matrix or strip. */
  visual?: ReactNode;
  /** One verdict sentence (≤ 25 words), inline content only. */
  verdict?: ReactNode;
  /** At most three chips, in order: confidence · inheritance · scope. */
  chipRow?: ReactNode;
  /**
   * Summary-layer content after the chips: facts (`FactGrid`) and
   * current-state callouts. In a split body it sits beside the visual.
   *
   * A `ModuleDisclosure` or `EvidenceFooter` passed directly as a child is
   * lifted out of the summary layer into the fold run (disclosures first,
   * the footer last). A fold rendered by any other component or nested in a
   * wrapper is not recognised and stays in the summary layer: pass it, with
   * every other domain fold, through `folds`.
   */
  children?: ReactNode;
  /**
   * The domain folds in their fixed order (Scoring breakdown → domain
   * detail), as named disclosures or one wrapper holding them. Rendered once,
   * full width, after the summary layer and before the provenance `footer`,
   * so a split body never strands a fold in one column.
   */
  folds?: ReactNode;
  /** The provenance (`EvidenceFooter`): its fold, then its line, always last and full width. */
  footer?: ReactNode;
  /**
   * Defaults to `split` in strip form (at `@3xl/evidence`, 48rem) and `stack`
   * otherwise. A full-width module opts in to split at `@5xl/evidence`
   * (64rem: the 1,472 px column at 1920, not the 992 px one at 1440). A body
   * without a visual, or with nothing beside it, always stacks.
   */
  bodyLayout?: EvidenceModuleBodyLayout;
  className?: string;
  /**
   * Fold the whole module to its header below `md` (phone only, decision S8).
   * Defaults to true for tiles and strips, false for full-width modules.
   */
  collapsibleOnMobile?: boolean;
}

/**
 * The (?) help glyph keeps its 24 px disc at every width; below `md` its
 * 44 px tap target is an invisible pseudo-element around the disc, so the
 * target neither paints a large disc in the header nor pushes the layout.
 */
const METHODOLOGY_SLOT_CLASS =
  "relative inline-flex shrink-0 items-center [&_button]:relative [&_button]:h-6 [&_button]:w-6 [&_button]:after:absolute [&_button]:after:-inset-2.5";

/**
 * Sorts `children` into the summary layer and the fold run, keeping each
 * group's own order: summary content, then disclosures, then provenance.
 */
function partitionBodyChildren(children: ReactNode) {
  const summary: ReactNode[] = [];
  const domainFolds: ReactNode[] = [];
  const provenance: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    const type = isValidElement(child) ? child.type : null;
    if (type === EvidenceFooter) provenance.push(child);
    else if (type === ModuleDisclosure) domainFolds.push(child);
    else summary.push(child);
  }
  return { summary, domainFolds, provenance };
}

/**
 * The first header chip is the module's status; the rest (ops, role tag) are
 * secondary. Null when there is no chip, so no empty row is laid out.
 */
function splitHeaderChips(headerRight: ReactNode) {
  const chips = Children.toArray(
    isValidElement<{ children?: ReactNode }>(headerRight) && headerRight.type === Fragment
      ? headerRight.props.children
      : headerRight,
  );
  return chips.length > 0 ? { primary: chips[0], secondary: chips.slice(1) } : null;
}

/**
 * The main-column evidence module (plan §8a). One shell, one order:
 * header (logo · ticker · title, help glyph, status) → visual → verdict →
 * chips → facts → domain folds → provenance fold → footer line, at the main
 * density tier.
 *
 * The header wraps rather than truncates. The title row keeps the help glyph
 * directly after the title (and, on a phone accordion, the chevron at the
 * right edge). At `md+` the status chips sit at the right of that row and
 * drop under the title, left-aligned, only when both do not fit. Below `md`
 * they always take their own row under the title. A score or status chip
 * never shrinks or ellipsizes: it is the module's verdict.
 *
 * At `md+` the summary layer never folds and no toggle exists. Below `md`, a
 * tile or strip becomes an APG accordion (`<h3><button aria-expanded
 * aria-controls>`). The server and first client render are identical and the
 * collapsed body is hidden by CSS only below `md`, so there is no hydration
 * mismatch and no layout shift on desktop. The plain `<button>` is swapped for
 * static title text once the client knows it is on a wide viewport, so
 * keyboard users never meet an inert toggle there.
 */
export function EvidenceModule({
  id,
  title,
  variant,
  stripForm = false,
  headingLevel = "h3",
  methodology,
  headerRight,
  visual,
  verdict,
  chipRow,
  children,
  folds,
  footer,
  bodyLayout,
  className,
  collapsibleOnMobile,
}: EvidenceModuleProps) {
  const layout: EvidenceModuleVariant = stripForm ? "strip" : variant;
  const isStrip = layout === "strip";
  const collapsible = collapsibleOnMobile ?? variant !== "module";
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const interactive = collapsible && !isDesktop;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const generatedId = useId();
  const headingId = id ? `${id}-title` : `${generatedId}-title`;
  const bodyId = id ? `${id}-body` : `${generatedId}-body`;
  const headerChips = splitHeaderChips(headerRight);

  // Deep links arrive on load (before lazy sections settle) and while the page
  // is open, when only `hashchange` fires. A target anywhere inside the module
  // (a nested disclosure id such as `#mint-review-notes`) unfolds it too.
  useEffect(() => {
    const root = rootRef.current;
    if (!collapsible || !root) return;
    const openOnHashMatch = () => {
      let targetId: string;
      try {
        targetId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      } catch {
        return;
      }
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (target && root.contains(target)) setOpen(true);
    };
    const expand = () => setOpen(true);
    openOnHashMatch();
    window.addEventListener("hashchange", openOnHashMatch);
    root.addEventListener(EXPAND_EVENT, expand);
    return () => {
      window.removeEventListener("hashchange", openOnHashMatch);
      root.removeEventListener(EXPAND_EVENT, expand);
    };
  }, [collapsible]);

  const header = (
    <div
      className={cn(
        DETAIL_MODULE_HEADER_CLASS,
        "relative gap-y-2",
        // A foldable module draws the header divider as the body's top border,
        // so the divider disappears with the folded body (no `max-*` variants:
        // this pipeline does not emit them).
        collapsible && "border-b-0",
      )}
    >
      {/* The title row. `[&>div:first-child]` is the logo · ticker · title
          row of `StablecoinModuleTitle`: kept on one line so the ticker never
          strands its "·" above the title; only the title text itself wraps. */}
      <div className="flex min-w-0 grow items-center gap-1.5 [&>div:first-child]:flex-nowrap">
        <StablecoinModuleTitle as={headingLevel} id={headingId} className={cn(DETAIL_MODULE_TITLE_CLASS, "min-w-0 text-balance")}>
          {interactive ? (
            // The overlay stretches the hit area across the whole header; the
            // help glyph and the status chips sit above it (`relative`).
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((value) => !value)}
              className="pharos-focus-ring rounded-sm text-left after:absolute after:inset-0 md:after:hidden"
            >
              {title}
            </button>
          ) : (
            title
          )}
        </StablecoinModuleTitle>
        {methodology ? <span className={METHODOLOGY_SLOT_CLASS}>{methodology}</span> : null}
        {interactive ? (
          <ChevronDown
            aria-hidden="true"
            className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-[expanded=true]/evidence:rotate-180 md:hidden"
          />
        ) : null}
      </div>
      {headerChips ? (
        // Its own row below `md`; beside the title at `md+` when it fits.
        // Alone on a row too narrow for every chip, the chips wrap, not clip.
        // The chips (not the row) sit above the accordion overlay, so a tap
        // beside them still toggles the module.
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 md:basis-auto [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal [&>*]:relative [&>*]:shrink-0">
          {headerChips.primary}
          {headerChips.secondary.length > 0 ? (
            // A folded band keeps the primary chip only; `contents` lets the
            // secondary chips flow as the row's own flex items otherwise.
            <span className="contents group-data-[expanded=false]/evidence:hidden md:!contents [&>*]:relative [&>*]:shrink-0">
              {headerChips.secondary}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const { summary, domainFolds, provenance } = partitionBodyChildren(children);
  const hasVisual = visual != null && visual !== false;
  const verdictNode = verdict ? (
    <p className="text-sm leading-relaxed text-pretty text-foreground">{verdict}</p>
  ) : null;
  const chipRowNode = chipRow ? <div className="flex flex-wrap items-center gap-1.5">{chipRow}</div> : null;
  const hasBesideVisual = verdictNode !== null || chipRowNode !== null || summary.length > 0;
  const split = (bodyLayout ?? (isStrip ? "split" : "stack")) === "split" && hasVisual && hasBesideVisual;

  const body = (
    <div
      id={bodyId}
      className={cn(
        DETAIL_MODULE_BODY_CLASS,
        "min-w-0 space-y-4",
        MODULE_FOLD_RHYTHM_CLASS,
        collapsible && "border-t border-border/40",
        // `data-expanded` stays "false" at md+, so the override must beat the
        // group selector's specificity: `!` keeps the body visible on desktop.
        collapsible && "group-data-[expanded=false]/evidence:hidden md:!block",
      )}
    >
      {split ? (
        // Only the summary layer splits; the fold run below spans the module.
        <div
          className={cn(
            "grid gap-x-8 gap-y-4",
            layout === "module" ? "@5xl/evidence:grid-cols-2" : "@3xl/evidence:grid-cols-2",
          )}
        >
          <div className="min-w-0">{visual}</div>
          <div className={cn("min-w-0 space-y-4", MODULE_FOLD_RHYTHM_CLASS)}>
            {verdictNode}
            {chipRowNode}
            {summary}
          </div>
        </div>
      ) : (
        <>
          {visual}
          {verdictNode}
          {chipRowNode}
          {summary}
        </>
      )}
      {/* One fold run, in fixed order, as direct children of the body so
          `MODULE_FOLD_RHYTHM_CLASS` closes the gaps between them. */}
      {domainFolds}
      {folds}
      {provenance}
      {footer}
    </div>
  );

  return (
    <section
      ref={rootRef}
      id={id}
      aria-labelledby={headingId}
      data-evidence-module={layout}
      data-expanded={collapsible ? String(open) : undefined}
      className={cn(
        DETAIL_MODULE_SHELL_CLASS,
        "group/evidence @container/evidence",
        isStrip && "col-span-full",
        id ? SECTION_SCROLL_MT : undefined,
        className,
      )}
    >
      {header}
      {body}
    </section>
  );
}

export type EvidenceState = "not-reviewed" | "not-applicable";

const EVIDENCE_STATE_LABEL: Record<EvidenceState, string> = {
  "not-reviewed": "Not reviewed",
  "not-applicable": "Not applicable",
};

/**
 * The explicit one-line state for a module the archetype could carry but this
 * coin lacks (decision S14): "<Title> · Not reviewed" or "<Title> · Not
 * applicable · <reason>". It sits in the module's usual slot so absence is
 * stated, never silent.
 *
 * Deliberately neutral: a dashed outline and a dashed (not reviewed) or
 * slashed (not applicable) glyph, muted text, no red or green — a missing
 * review is unknown, not a failure.
 */
export function EvidenceStateStrip({
  id,
  title,
  state,
  reason,
  density,
  headingLevel,
  className,
}: {
  id?: string;
  title: string;
  state: EvidenceState;
  /** Rationale shown after the state, e.g. "not applicable to NAV tokens". */
  reason?: string;
  /** Main column (header padding of `DETAIL_MODULE_*`) or the 22rem rail (`RailCard`). */
  density: "main" | "rail";
  /** Defaults to `h3` in the main column (inside a board) and `h2` in the rail. */
  headingLevel?: "h2" | "h3";
  className?: string;
}) {
  const generatedId = useId();
  const headingId = id ? `${id}-title` : `${generatedId}-title`;
  const Heading = headingLevel ?? (density === "main" ? "h3" : "h2");
  const Glyph = state === "not-reviewed" ? CircleDashed : CircleSlash;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-evidence-state={state}
      className={cn(
        "rounded-xl border border-dashed border-border",
        id ? SECTION_SCROLL_MT : undefined,
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1",
          density === "main" ? "px-4 py-5 sm:px-5" : "px-4 py-3.5",
        )}
      >
        <Glyph aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Heading id={headingId} className={DETAIL_MODULE_TITLE_CLASS}>
          {title}
        </Heading>
        <span aria-hidden="true" className="text-muted-foreground/50">·</span>
        <span className="text-sm text-muted-foreground">{EVIDENCE_STATE_LABEL[state]}</span>
        {reason ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className="min-w-0 text-xs leading-snug text-muted-foreground">{reason}</span>
          </>
        ) : null}
      </div>
    </section>
  );
}
