import type {
  MintAuthorityClientControlSummary,
  MintAuthorityMintPath,
  MintAuthorityPosture,
} from "@shared/types/stablecoin-client-meta";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { countSummaryWords, SUMMARY_VERDICT_MAX_WORDS } from "@shared/lib/summary-budget";

/**
 * The Mint Authority summary-layer verdict: one bounded-vocabulary sentence
 * built only from structured review fields (band, mint path, the controls
 * that can create or authorize supply, authority posture, inheritance), so it
 * can never leak reviewer narrative, addresses, block heights or gate codes.
 * An authored `mintAuthority.headline` overrides it upstream.
 */
export interface MintAuthorityVerdictInput {
  symbol: string;
  /** Published posture band label ("Managed"); null when the component is NR. */
  bandLabel: string | null;
  mintPath: MintAuthorityMintPath;
  authorityPosture: MintAuthorityPosture;
  controls: readonly MintAuthorityVerdictControl[];
  /** True when the client census is bounded, so per-type counts are lower bounds. */
  controlsTruncated: boolean;
  /** Parent symbol for wrapper/variant profiles that inherit mint risk. */
  parentSymbol: string | null;
}

export type MintAuthorityVerdictControl = Pick<
  MintAuthorityClientControlSummary,
  "authorityType" | "directMintAbility" | "threshold" | "signerCount" | "timelockDelaySec"
>;

/** Compact delay ("1d", "48h", "30m") shared with the control-row timelock label. */
export function formatMintTimelockDelay(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  const days = seconds / DAY_SECONDS;
  if (Number.isInteger(days)) return `${days}d`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** Abilities that create supply or authorize who can; upgrade/parameter-only powers are not a mint gate. */
const MINT_GATE_ABILITIES: Record<string, true> = { direct: true, "cap-limited": true, "can-authorize": true };

/** Strongest gate first: thresholded and delayed controls say the most about who can mint. */
const AUTHORITY_TYPE_ORDER = [
  "safe",
  "multisig",
  "timelock",
  "dao-governor",
  "validator-quorum",
  "issuer-backend",
  "custodian",
  "bridge",
  "eoa",
  "contract",
  "unknown",
] as const;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** Singular noun (no article) and plural noun per authority type. */
const AUTHORITY_TYPE_NOUNS: Record<(typeof AUTHORITY_TYPE_ORDER)[number], { one: string; many: string } | { mass: string }> = {
  safe: { one: "Safe", many: "Safes" },
  multisig: { one: "multisig", many: "multisigs" },
  timelock: { one: "timelock", many: "timelocks" },
  "dao-governor": { mass: "DAO governance" },
  "validator-quorum": { one: "validator quorum", many: "validator quorums" },
  "issuer-backend": { mass: "issuer backend signers" },
  custodian: { one: "custodian", many: "custodians" },
  bridge: { one: "bridge", many: "bridges" },
  eoa: { one: "EOA", many: "EOAs" },
  contract: { one: "contract", many: "contracts" },
  unknown: { one: "unresolved control", many: "unresolved controls" },
};

const PATH_PHRASES: Record<MintAuthorityMintPath, (symbol: string, parent: string | null) => string> = {
  "immutable-user-collateralized": (symbol) => `users mint ${symbol} against collateral in immutable contracts`,
  "user-collateralized-governed": (symbol) => `users mint ${symbol} against collateral under governance`,
  "issuer-direct-mint": (symbol) => `the issuer mints ${symbol} directly`,
  "permissioned-minter": (symbol) => `permissioned minters create ${symbol}`,
  "offchain-attested-minter": (symbol) => `approved minters issue ${symbol} against off-chain attestations`,
  "facilitator-bucket-mint": (symbol) => `facilitators mint ${symbol} within bucket caps`,
  "amo-or-custodian-hybrid": (symbol) => `AMOs and custodians mint ${symbol}`,
  "bridge-or-oft-synthetic": (symbol) => `${symbol} is minted by bridge messages`,
  "m0-permissioned-minter": (symbol) => `approved M0 minters create ${symbol}`,
  "wrapped-or-variant-inherited": (symbol, parent) =>
    parent ? `${symbol} wraps ${parent} and inherits its mint risk` : `${symbol} inherits mint risk from its parent`,
  unknown: (symbol) => `the ${symbol} mint path is unresolved`,
};

/** Paths whose control census does not describe who can mint this token. */
const PATHS_WITHOUT_CONTROL_CLAUSE: Partial<Record<MintAuthorityMintPath, true>> = {
  "immutable-user-collateralized": true,
  "wrapped-or-variant-inherited": true,
  unknown: true,
};

const POSTURE_PHRASES: Record<MintAuthorityPosture, string> = {
  "none-resolved": "no privileged mint authority was found",
  "none-resolved-mint": "no local privileged mint path was found",
  "bounded-admin": "admin powers are bounded",
  "partially-bounded-admin": "admin powers are only partly bounded",
  "unbounded-reconciled": "supply is unbounded but reconciled or supervised",
  "unbounded-governed": "supply is unbounded but governance-delayed",
  "unbounded-veto-guarded": "supply is unbounded but veto-guarded",
  "unbounded-operationally-governed": "supply is unbounded within governed operating limits",
  "concentrated-admin": "admin power is concentrated",
  "collateral-gated": "minting is collateral-gated but admin-controlled",
  "unbounded-adverse": "supply is unbounded under adverse authority",
  compromised: "mint authority is compromised by an active incident",
  unknown: "the authority posture is unresolved",
};

/** Qualifier shared by every control in a group ("3/6", "1d"), or null when they differ. */
function sharedQualifier(type: string, group: readonly MintAuthorityVerdictControl[]): string | null {
  const qualify = (control: MintAuthorityVerdictControl) =>
    type === "timelock"
      ? formatMintTimelockDelay(control.timelockDelaySec)
      : control.threshold != null && control.signerCount != null
        ? `${control.threshold}/${control.signerCount}`
        : null;
  const first = qualify(group[0]!);
  return first != null && group.every((control) => qualify(control) === first) ? first : null;
}

function describeGroup(type: (typeof AUTHORITY_TYPE_ORDER)[number], group: readonly MintAuthorityVerdictControl[], truncated: boolean): string {
  const nouns = AUTHORITY_TYPE_NOUNS[type];
  if ("mass" in nouns) return nouns.mass;
  const qualifier = type === "safe" || type === "multisig" || type === "timelock" ? sharedQualifier(type, group) : null;
  if (group.length === 1) {
    const phrase = qualifier ? `${qualifier} ${nouns.one}` : nouns.one;
    // "an EOA", "an 8/12 multisig", "an 18h timelock".
    return `${/^(?:[aeiou]|8|11|18)/i.test(phrase) ? "an" : "a"} ${phrase}`;
  }
  // A bounded census only proves a lower bound, so the count stays unnamed.
  const count = truncated ? "multiple" : (NUMBER_WORDS[group.length] ?? String(group.length));
  return `${count} ${qualifier ? `${qualifier} ` : ""}${nouns.many}`;
}

/** "a 5/10 Safe and a 1d timelock" — the two strongest mint-gate groups, or null when none gate minting. */
export function describeMintGateControls(
  controls: readonly MintAuthorityVerdictControl[],
  truncated: boolean,
): string | null {
  const groups = new Map<(typeof AUTHORITY_TYPE_ORDER)[number], MintAuthorityVerdictControl[]>();
  for (const control of controls) {
    if (!MINT_GATE_ABILITIES[control.directMintAbility]) continue;
    const type = (AUTHORITY_TYPE_ORDER as readonly string[]).includes(control.authorityType)
      ? (control.authorityType as (typeof AUTHORITY_TYPE_ORDER)[number])
      : "unknown";
    groups.set(type, [...(groups.get(type) ?? []), control]);
  }
  const phrases = AUTHORITY_TYPE_ORDER.filter((type) => groups.has(type))
    .slice(0, 2)
    .map((type) => describeGroup(type, groups.get(type)!, truncated));
  return phrases.length > 0 ? phrases.join(" and ") : null;
}

export function buildMintAuthorityVerdict(input: MintAuthorityVerdictInput): string {
  const prefix = `${input.bandLabel ?? "Not rated"} —`;
  const path = PATH_PHRASES[input.mintPath](input.symbol, input.parentSymbol);
  const gate = PATHS_WITHOUT_CONTROL_CLAUSE[input.mintPath]
    ? null
    : describeMintGateControls(input.controls, input.controlsTruncated);
  const posture = POSTURE_PHRASES[input.authorityPosture];

  // Longest first; shed the controls clause, then the posture, to stay inside the verdict budget.
  const candidates = [
    gate ? `${prefix} ${path}, controlled by ${gate}; ${posture}.` : null,
    `${prefix} ${path}; ${posture}.`,
    `${prefix} ${path}.`,
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => countSummaryWords(candidate) <= SUMMARY_VERDICT_MAX_WORDS) ?? candidates.at(-1)!;
}
