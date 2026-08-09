// src/lib/stablecoin-detail-custody-client.ts
import type {
  CustodyBankruptcyRemoteness,
  CustodyProfile,
  CustodyProviderRole,
  CustodyRehypothecation,
  CustodySegregation,
  MechanismArchetype,
  StablecoinLink,
  StablecoinMeta,
} from "@shared/types";

/**
 * Client-safe projection of the server-only `custodyProfile` review, in the
 * `projectBridgeRouteRiskClientSummary` pattern: bounded labels, provider rows,
 * and counts only, so the raw review never ships wholesale to the browser.
 */
export interface CustodyProviderClientRow {
  key: string;
  name: string;
  roleLabel: string;
  jurisdiction: string | null;
  sharePct: number | null;
}

export type CustodyPostureKey = "segregated-remote" | "segregated" | "omnibus-or-mixed" | "undisclosed";

export interface CustodyClientSummary {
  postureKey: CustodyPostureKey;
  postureLabel: string;
  postureToneClass: string;
  summary: string;
  providers: CustodyProviderClientRow[];
  undisclosedSharePct: number | null;
  segregationLabel: string;
  bankruptcyRemotenessLabel: string;
  rehypothecationLabel: string;
  /** Amber tone when rehypothecation is permitted/conditional; null otherwise. */
  rehypothecationToneClass: string | null;
  confidenceLabel: string;
  uncertainty: string | null;
  reviewedAt: string;
  sources: StablecoinLink[];
}

const ROLE_LABELS: Record<CustodyProviderRole, string> = {
  custodian: "Custodian",
  subcustodian: "Sub-custodian",
  bank: "Bank",
  "prime-broker": "Prime broker",
  other: "Other",
};

const SEGREGATION_LABELS: Record<CustodySegregation, string> = {
  segregated: "Segregated",
  omnibus: "Omnibus",
  mixed: "Mixed",
  unknown: "Unknown",
};

const BANKRUPTCY_LABELS: Record<CustodyBankruptcyRemoteness, string> = {
  structured: "Structural",
  "contractual-only": "Contractual",
  none: "None",
  unknown: "Unknown",
};

const REHYPOTHECATION_LABELS: Record<CustodyRehypothecation, string> = {
  prohibited: "Prohibited",
  permitted: "Permitted",
  conditional: "Conditional",
  unknown: "Unknown",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  verified: "Verified",
  probable: "Probable",
  "manual-review": "Manual review",
  unknown: "Unknown",
};

const POSTURE_LABELS: Record<CustodyPostureKey, string> = {
  "segregated-remote": "Segregated · remote",
  segregated: "Segregated",
  "omnibus-or-mixed": "Omnibus / mixed",
  undisclosed: "Undisclosed",
};

// Tone strings match the bridge-client TIER_TONES palette byte-for-byte.
const POSTURE_TONES: Record<CustodyPostureKey, string> = {
  "segregated-remote": "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  segregated: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "omnibus-or-mixed": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  undisclosed: "border-border/60 bg-muted/30 text-muted-foreground",
};

const SEGREGATION_CLAUSES: Record<CustodySegregation, string> = {
  segregated: "client assets are held in segregated accounts",
  omnibus: "assets are held in omnibus accounts",
  mixed: "custody mixes segregated and omnibus accounts",
  unknown: "the account structure is undisclosed",
};

const BANKRUPTCY_CLAUSES: Record<CustodyBankruptcyRemoteness, string | null> = {
  structured: "with structural bankruptcy remoteness",
  "contractual-only": "with contractual-only bankruptcy protections",
  none: "without bankruptcy-remote protections",
  unknown: null,
};

const REHYPOTHECATION_SENTENCES: Record<CustodyRehypothecation, string | null> = {
  prohibited: "Rehypothecation is prohibited.",
  permitted: "Rehypothecation is permitted.",
  conditional: "Rehypothecation is conditionally permitted.",
  unknown: null,
};

function resolvePostureKey(profile: CustodyProfile): CustodyPostureKey {
  if (profile.segregation === "unknown") return "undisclosed";
  if (profile.segregation === "segregated") {
    return profile.bankruptcyRemoteness === "structured" ? "segregated-remote" : "segregated";
  }
  return "omnibus-or-mixed";
}

function composeSummary(profile: CustodyProfile): string {
  const providers = profile.providers;
  const lead =
    providers.length === 0
      ? "Reserve custody counterparties are not individually disclosed"
      : providers.length === 1
        ? `Reserve custody is held by ${providers[0]!.name}`
        : `Reserve custody spans ${providers.length} counterparties, led by ${providers[0]!.name}`;
  const bankruptcy = BANKRUPTCY_CLAUSES[profile.bankruptcyRemoteness];
  const first = `${lead}; ${SEGREGATION_CLAUSES[profile.segregation]}${bankruptcy ? ` ${bankruptcy}` : ""}.`;
  const rehypothecation = REHYPOTHECATION_SENTENCES[profile.rehypothecation];
  return rehypothecation ? `${first} ${rehypothecation}` : first;
}

/**
 * Owner display rule (2026-08-09): the custody module is for mechanisms that
 * centrally custody assets. An explicit curated custodyModel wins; without
 * one, on-chain mechanism archetypes (cdp, algorithmic) are suppressed. The
 * resilience-defaults inference is deliberately NOT used here: it maps
 * crypto-backed:centralized-dependent to "onchain", which would wrongly hide
 * genuinely custodial coins that merely lack an explicit custodyModel.
 */
export function shouldDisplayCustodyModule(
  coin: Pick<StablecoinMeta, "custodyModel">,
  resolvedArchetype: MechanismArchetype | null,
): boolean {
  if (coin.custodyModel) return coin.custodyModel !== "onchain";
  return resolvedArchetype !== "cdp" && resolvedArchetype !== "algorithmic";
}

export function projectCustodyClientSummary(coin: StablecoinMeta): CustodyClientSummary | null {
  const profile = coin.custodyProfile;
  if (!profile) return null;
  const postureKey = resolvePostureKey(profile);
  return {
    postureKey,
    postureLabel: POSTURE_LABELS[postureKey],
    postureToneClass: POSTURE_TONES[postureKey],
    summary: composeSummary(profile),
    providers: profile.providers.map((provider, index) => ({
      key: `${provider.name}:${index}`,
      name: provider.name,
      roleLabel: ROLE_LABELS[provider.role] ?? provider.role,
      jurisdiction: provider.jurisdiction ?? null,
      sharePct: provider.sharePct ?? null,
    })),
    undisclosedSharePct: profile.knownUnknownExposurePct ?? null,
    segregationLabel: SEGREGATION_LABELS[profile.segregation] ?? profile.segregation,
    bankruptcyRemotenessLabel: BANKRUPTCY_LABELS[profile.bankruptcyRemoteness] ?? profile.bankruptcyRemoteness,
    rehypothecationLabel: REHYPOTHECATION_LABELS[profile.rehypothecation] ?? profile.rehypothecation,
    rehypothecationToneClass:
      profile.rehypothecation === "permitted" || profile.rehypothecation === "conditional"
        ? "text-amber-700 dark:text-amber-400"
        : null,
    confidenceLabel: CONFIDENCE_LABELS[profile.confidence] ?? profile.confidence,
    uncertainty: profile.uncertainty || null,
    reviewedAt: profile.reviewedAt,
    sources: profile.sources ?? [],
  };
}
