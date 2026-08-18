import type { MechanismArchetype, VariantKind } from "@shared/types";

import { renderArchetype } from "./render-archetype";

interface WrapperDiagramProps {
  /** Child (wrapper) symbol, e.g. "sUSDe", "sDAI". */
  symbol: string;
  /** Parent symbol whose mechanism the wrapper inherits, e.g. "USDe". */
  parentSymbol: string;
  /** Parent's mechanism archetype, used to choose the inner diagram. */
  parentArchetype: MechanismArchetype;
  /** Parent coin's `flags.navToken`, which selects the parent panel's copy. */
  parentNavToken?: boolean | null;
  /** Optional wrapper kind controls the right-hand description. */
  variantKind?: VariantKind;
}

const VARIANT_DESCRIPTION: Record<VariantKind, string> = {
  "pure-wrapper": "wraps and unwraps the parent claim 1:1",
  "savings-passthrough": "routes savings yield to holders",
  "strategy-vault": "routes strategy yield to holders",
  "risk-absorption": "absorbs first-loss for senior holders",
  "bond-maturity": "fixed-maturity bond exposure",
};

const VARIANT_KICKER: Record<VariantKind, string> = {
  "pure-wrapper": "1:1 wrapper",
  "savings-passthrough": "savings vault",
  "strategy-vault": "strategy vault",
  "risk-absorption": "risk-absorption vault",
  "bond-maturity": "bond-maturity vault",
};

const VARIANT_STRESS_FOOTNOTE: Record<VariantKind, string> = {
  "pure-wrapper": "stress: parent stress + wrapper contract",
  "savings-passthrough": "stress: parent stress + redemption queue",
  "strategy-vault": "stress: parent stress + strategy unwind",
  "risk-absorption": "stress: parent stress + first-loss absorption",
  "bond-maturity": "stress: parent stress + maturity mismatch",
};

export function WrapperDiagram({
  symbol,
  parentSymbol,
  parentArchetype,
  parentNavToken,
  variantKind,
}: WrapperDiagramProps) {
  const kicker = variantKind ? VARIANT_KICKER[variantKind] : "wrapper vault";
  const description = variantKind
    ? VARIANT_DESCRIPTION[variantKind]
    : "routes yield to holders";
  const stressFootnote = variantKind
    ? VARIANT_STRESS_FOOTNOTE[variantKind]
    : "stress: parent stress + redemption queue";
  const ariaLabel = `${symbol} is a ${kicker} wrapping ${parentSymbol}; it ${description}.`;

  return (
    <div
      className="w-full max-w-2xl"
      role="img"
      aria-label={ariaLabel}
      data-testid="wrapper-diagram"
    >
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div
          className="flex-[3] min-w-0"
          style={{ opacity: 0.85 }}
          aria-hidden="true"
          data-testid="wrapper-parent-diagram"
        >
          <p
            className="mb-1 text-[10px] uppercase tracking-[0.14em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {parentSymbol} mechanism
          </p>
          {renderArchetype(parentArchetype, parentSymbol, { stressFootnote: "" }, parentNavToken)}
        </div>

        <svg
          aria-hidden="true"
          className="hidden sm:block shrink-0"
          width={32}
          height={24}
          viewBox="0 0 32 24"
        >
          <line
            x1={2}
            y1={12}
            x2={22}
            y2={12}
            stroke="var(--text-tertiary)"
            strokeWidth={1.75}
            strokeLinecap="round"
          />
          <polygon
            points="22,6.5 30,12 22,17.5"
            fill="var(--text-tertiary)"
          />
        </svg>

        <div className="flex-[2] min-w-0">
          <p
            className="mb-1 text-[10px] uppercase tracking-[0.14em]"
            style={{ color: "var(--text-tertiary)" }}
          >
            wrapper layer
          </p>
          <div
            className="rounded-md border px-3 py-3"
            style={{
              background: "var(--card)",
              borderColor: "var(--border-default)",
            }}
            data-testid="wrapper-variant-box"
          >
            <p className="text-sm font-semibold" style={{ color: "currentColor" }}>
              {symbol}
            </p>
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-secondary)" }}
            >
              wrapped in {kicker} — {description}
            </p>
          </div>
        </div>
      </div>
      <p
        className="hidden sm:block mx-auto mt-2 max-w-2xl text-center text-xs italic"
        style={{ color: "var(--text-tertiary)" }}
        data-testid="wrapper-stress-footnote"
      >
        {stressFootnote}
      </p>
    </div>
  );
}
