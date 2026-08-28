import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Clock,
  FileCode2,
  KeyRound,
  Landmark,
  Server,
  ShieldQuestion,
  Users,
  Vault,
} from "lucide-react";
import { revealAnchorId } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";
import { MINT_AUTHORITY_POSTURE_DOT_CLASS } from "@/components/stablecoin-detail/mint-authority-presentation";
import type {
  MintAuthorityDetailControlViewModel,
  MintAuthorityPostureTone,
} from "@/lib/stablecoin-detail-mint-authority-view-model";

/** Glyph per bounded `authorityType` key; EOAs carry a caution tone. */
const AUTHORITY_GLYPHS: Record<string, { icon: LucideIcon; caution?: boolean }> = {
  safe: { icon: Users },
  multisig: { icon: Users },
  eoa: { icon: KeyRound, caution: true },
  timelock: { icon: Clock },
  "dao-governor": { icon: Landmark },
  contract: { icon: FileCode2 },
  "issuer-backend": { icon: Server },
  bridge: { icon: ArrowLeftRight },
  custodian: { icon: Vault },
};

const MAX_RAIL_CONTROLS = 3;
const MAX_SIGNER_DOTS = 8;

function SignerDots({ threshold, signerCount }: { threshold: number; signerCount: number }) {
  if (signerCount > MAX_SIGNER_DOTS) {
    return <span className="pharos-numeric text-[10px] text-muted-foreground">{threshold}/{signerCount}</span>;
  }
  return (
    <span className="inline-flex items-center gap-[3px]" title={`${threshold} of ${signerCount} signers required`}>
      {Array.from({ length: signerCount }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            index < threshold ? "bg-foreground/80" : "bg-muted-foreground/25",
          )}
        />
      ))}
      <span className="pharos-numeric ml-0.5 text-[10px] text-muted-foreground">
        {threshold}/{signerCount}
      </span>
    </span>
  );
}

function ControlChip({ control }: { control: MintAuthorityDetailControlViewModel }) {
  const glyph = AUTHORITY_GLYPHS[control.authorityTypeKey] ?? { icon: ShieldQuestion };
  const Icon = glyph.icon;
  const showDots = control.threshold != null && control.signerCount != null && control.signerCount > 0;
  // "Externally owned account" would drown the chip; the short bounded forms
  // stay recognizable at a glance and the row's title carries the full label.
  const typeShort = control.authorityTypeKey === "eoa" ? "EOA" : control.authorityTypeLabel;

  return (
    <span
      title={`${control.label} — ${control.securitySetupLabel}`}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "h-3 w-3 shrink-0",
          glyph.caution ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "truncate text-[11px] font-medium",
          glyph.caution ? "text-amber-700 dark:text-amber-400" : "text-foreground/90",
        )}
      >
        {typeShort}
      </span>
      {showDots ? <SignerDots threshold={control.threshold!} signerCount={control.signerCount!} /> : null}
      {control.timelockLabel ? (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <Clock aria-hidden="true" className="h-2.5 w-2.5" />
          {control.timelockLabel}
        </span>
      ) : null}
    </span>
  );
}

function RailArrow() {
  return (
    <div aria-hidden="true" className="sm:min-w-6 sm:flex-1">
      <div className="hidden items-center sm:flex">
        <span className="h-px w-full bg-border" />
        <span className="border-y-4 border-l-[5px] border-border border-y-transparent" />
      </div>
      <div className="ml-4 flex h-4 flex-col items-center sm:hidden">
        <span className="h-full w-px bg-border" />
        <span className="border-x-4 border-t-[5px] border-border border-x-transparent" />
      </div>
    </div>
  );
}

function StationLabel({ children }: { children: string }) {
  return (
    <span className="text-[9px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The supply-creation rail: issuer → controls → supply, in the drawn-mechanism
 * grammar (design principle 7 — every shape encodes a field). Signer dots are
 * the multisig threshold, the clock is the timelock, the caution key is an
 * EOA, and the supply annotation is the published authority posture.
 *
 * Horizontal from `sm`, vertical below (the Peg Stability precedent). Returns
 * null when there are no reviewed controls — the module then keeps its
 * text-chip summary, so unreviewed coins never render a broken diagram.
 */
export function MintAuthorityRail({
  symbol,
  mintPathShortLabel,
  mintPathLabel,
  postureLabel,
  postureTone,
  controls,
}: {
  symbol: string;
  mintPathShortLabel: string;
  /** Full mint-path label, carried as the origin station's title. */
  mintPathLabel?: string;
  postureLabel: string;
  postureTone: MintAuthorityPostureTone;
  controls: readonly MintAuthorityDetailControlViewModel[];
}) {
  if (controls.length === 0 || mintPathShortLabel === "Unknown") return null;
  const railControls = controls.slice(0, MAX_RAIL_CONTROLS);
  const hiddenControlCount = controls.length - railControls.length;

  return (
    <div
      role="img"
      aria-label={`Mint path: ${mintPathShortLabel} mints ${symbol} through ${controls.length === 1 ? "one control" : `${controls.length} controls`}; posture ${postureLabel}.`}
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <StationLabel>Issuer</StationLabel>
        <span
          title={mintPathLabel}
          className="inline-flex w-fit items-center rounded-md border border-border/60 px-2.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground"
        >
          {mintPathShortLabel}
        </span>
      </div>
      <RailArrow />
      <div className="flex min-w-0 flex-col gap-0.5">
        <StationLabel>Controls</StationLabel>
        <span className="flex flex-col items-start gap-1">
          {railControls.map((control) => (
            <ControlChip key={control.key} control={control} />
          ))}
          {hiddenControlCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                const details = revealAnchorId("mint-primary-controls");
                details?.scrollIntoView({ block: "nearest" });
              }}
              className="pharos-focus-ring rounded-sm text-[10px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
            >
              +{hiddenControlCount} more in Primary controls
            </button>
          ) : null}
        </span>
      </div>
      <RailArrow />
      <div className="flex min-w-0 flex-col gap-0.5">
        <StationLabel>Supply</StationLabel>
        <span className="inline-flex w-fit items-center rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {symbol}
        </span>
        <span className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] leading-snug text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", MINT_AUTHORITY_POSTURE_DOT_CLASS[postureTone])}
          />
          {postureLabel}
        </span>
      </div>
    </div>
  );
}
