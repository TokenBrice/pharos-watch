import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Clock,
  FileCode2,
  KeyRound,
  Landmark,
  Network,
  Server,
  ShieldQuestion,
  Users,
  Vault,
} from "lucide-react";
import { revealAnchorId } from "@/lib/anchor-reveal";
import { cn } from "@/lib/utils";
import { MINT_AUTHORITY_POSTURE_DOT_CLASS } from "@/components/stablecoin-detail/mint-authority-presentation";
import { RailArrow, StationLabel } from "@/components/stablecoin-detail/rail-station";
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
  "validator-quorum": { icon: Network },
  bridge: { icon: ArrowLeftRight },
  custodian: { icon: Vault },
};

const MAX_RAIL_CONTROLS = 3;
const MAX_SIGNER_DOTS = 8;

/**
 * Type nouns the glyph alone cannot carry: a role-first chip reads
 * "Minter admin EOA" or "Governor Safe" instead of a bare "Contract".
 */
const RAIL_TYPE_NOUNS: Record<string, string> = {
  safe: "Safe",
  multisig: "multisig",
  eoa: "EOA",
  timelock: "timelock",
};

/** Roles too generic to name a chip; the chip falls back to the authority type. */
const GENERIC_ROLE_KEYS: Record<string, true> = { other: true, unknown: true };

function SignerDots({ threshold, signerCount }: { threshold: number; signerCount: number }) {
  if (signerCount > MAX_SIGNER_DOTS) {
    return <span className="pharos-numeric text-[11px] text-muted-foreground">{threshold}/{signerCount}</span>;
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
      <span className="pharos-numeric ml-0.5 text-[11px] text-muted-foreground">
        {threshold}/{signerCount}
      </span>
    </span>
  );
}

/**
 * Name a chip by what the control does ("Minter admin", "Timelock"); the type
 * noun follows only where the glyph alone is ambiguous. Generic roles keep
 * the short bounded type ("EOA", not "Externally owned account").
 */
function railChipLabel(control: MintAuthorityDetailControlViewModel): string {
  const typeShort = control.authorityTypeKey === "eoa" ? "EOA" : control.authorityTypeLabel;
  const typeNoun = RAIL_TYPE_NOUNS[control.authorityTypeKey];
  if (GENERIC_ROLE_KEYS[control.roleKey]) return typeShort;
  return typeNoun && control.roleKey !== control.authorityTypeKey ? `${control.roleLabel} ${typeNoun}` : control.roleLabel;
}

/** One drawn control node: controls whose chips would read identically, merged. */
interface RailControlNode {
  key: string;
  label: string;
  control: MintAuthorityDetailControlViewModel;
  /** Every merged control's name, for the chip's hover text. */
  names: string[];
}

/**
 * Merges controls whose chip would draw the same thing (label, glyph, signer
 * threshold, delay) into one node with a count, in first-seen order, so three
 * plain "Direct minter" contracts read "Direct minter ×3" instead of three
 * indistinguishable chips.
 */
function groupRailControls(controls: readonly MintAuthorityDetailControlViewModel[]): RailControlNode[] {
  const nodes = new Map<string, RailControlNode>();
  for (const control of controls) {
    const label = railChipLabel(control);
    const key = [label, control.authorityTypeKey, control.threshold, control.signerCount, control.timelockLabel].join("|");
    const node = nodes.get(key);
    if (node) node.names.push(control.label);
    else nodes.set(key, { key, label, control, names: [control.label] });
  }
  return [...nodes.values()];
}

function ControlChip({ node }: { node: RailControlNode }) {
  const { control, label, names } = node;
  const glyph = AUTHORITY_GLYPHS[control.authorityTypeKey] ?? { icon: ShieldQuestion };
  const Icon = glyph.icon;
  const showDots = control.threshold != null && control.signerCount != null && control.signerCount > 0;

  // The name never truncates: when the station is narrow, the signer dots and
  // the delay wrap under it instead.
  return (
    <span
      title={`${names.join(", ")} — ${control.securitySetupLabel}`}
      className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1"
    >
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0",
            glyph.caution ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "text-[11px] font-medium",
            glyph.caution ? "text-amber-700 dark:text-amber-400" : "text-foreground/90",
          )}
        >
          {label}
        </span>
        {names.length > 1 ? (
          <span className="pharos-numeric text-[11px] text-muted-foreground">×{names.length}</span>
        ) : null}
      </span>
      {showDots ? <SignerDots threshold={control.threshold!} signerCount={control.signerCount!} /> : null}
      {control.timelockLabel ? (
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
          <Clock aria-hidden="true" className="h-3 w-3" />
          {control.timelockLabel}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The supply-creation rail: issuer → controls → supply, in the drawn-mechanism
 * grammar (design principle 7 — every shape encodes a field). Signer dots are
 * the multisig threshold, the clock is the timelock, the caution key is an
 * EOA, and the supply annotation is the published authority posture.
 * Controls that would draw identical chips merge into one node with a count.
 *
 * Horizontal from `sm`, vertical below (the Peg Stability precedent). The
 * issuer and controls stations keep their content width (names never
 * truncate); the supply caption wraps. Returns null when there are no
 * reviewed controls — the module then keeps its text-chip summary, so
 * unreviewed coins never render a broken diagram.
 */
export function MintAuthorityRail({
  symbol,
  mintPathShortLabel,
  mintPathLabel,
  postureLabel,
  postureTone,
  controls,
  totalControlCount = controls.length,
}: {
  symbol: string;
  mintPathShortLabel: string;
  /** Full mint-path label, carried as the origin station's title. */
  mintPathLabel?: string;
  postureLabel: string;
  postureTone: MintAuthorityPostureTone;
  controls: readonly MintAuthorityDetailControlViewModel[];
  totalControlCount?: number;
}) {
  if (controls.length === 0 || mintPathShortLabel === "Unknown") return null;
  const railNodes = groupRailControls(controls).slice(0, MAX_RAIL_CONTROLS);
  const drawnControlCount = railNodes.reduce((total, node) => total + node.names.length, 0);
  const hiddenControlCount = totalControlCount - drawnControlCount;

  return (
    <div
      role="img"
      aria-label={`Mint path: ${mintPathShortLabel} mints ${symbol} through ${totalControlCount === 1 ? "one control" : `${totalControlCount} controls`}; posture ${postureLabel}.`}
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex shrink-0 flex-col gap-0.5">
        <StationLabel>Issuer</StationLabel>
        <span
          title={mintPathLabel}
          className="inline-flex w-fit items-center whitespace-nowrap rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground"
        >
          {mintPathShortLabel}
        </span>
      </div>
      <RailArrow orientation="responsive" />
      <div className="flex flex-col gap-0.5">
        <StationLabel>Controls</StationLabel>
        <span className="flex flex-col items-start gap-1">
          {railNodes.map((node) => (
            <ControlChip key={node.key} node={node} />
          ))}
          {hiddenControlCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                const details = revealAnchorId("mint-primary-controls");
                details?.scrollIntoView({ block: "nearest" });
              }}
              className="pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground"
            >
              +{hiddenControlCount} more in Primary controls
            </button>
          ) : null}
        </span>
      </div>
      <RailArrow orientation="responsive" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <StationLabel>Supply</StationLabel>
        <span className="inline-flex w-fit items-center rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {symbol}
        </span>
        <span className="mt-0.5 inline-flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", MINT_AUTHORITY_POSTURE_DOT_CLASS[postureTone])}
          />
          {postureLabel}
        </span>
      </div>
    </div>
  );
}
