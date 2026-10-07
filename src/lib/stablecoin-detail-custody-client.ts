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
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import { RESEARCH_REVIEW_CONFIDENCE_LABELS } from "@shared/lib/classification";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { dedupeStablecoinLinksByUrl } from "@/lib/stablecoin-detail-links-client";

/**
 * Client-safe projection of the server-only `custodyProfile` review, in the
 * `projectBridgeRouteRiskClientSummary` pattern: bounded labels, provider rows,
 * and counts only, so the raw review never ships wholesale to the browser.
 */
export interface CustodyProviderClientRow {
  key: string;
  /** The reviewed name, verbatim (detail layer). */
  name: string;
  /** Chip label: trailing parenthetical and raw addresses removed. */
  shortName: string;
  roleLabel: string;
  jurisdiction: string | null;
  sharePct: number | null;
}

/**
 * A reviewed row that stands in for custodians nobody has named ("Systemically
 * important and other regulated banks (not individually disclosed)"). It is a
 * description, not a provider: it never renders as a chip or a roster row.
 */
export interface CustodyUnnamedHolderClientRow {
  key: string;
  /** The reviewed description, raw addresses removed, never truncated. */
  description: string;
  sharePct: number | null;
}

/**
 * The header chip, read off the protection meter: the account structure
 * (first rung), qualified by structural bankruptcy remoteness. When the
 * account structure is not established the chip states how much is.
 */
export type CustodyPostureKey =
  | "segregated-remote"
  | "segregated"
  | "mixed"
  | "omnibus"
  | "partly-disclosed"
  | "structure-undisclosed"
  | "undisclosed";

export type CustodyProtectionKey = "segregation" | "bankruptcy-remoteness" | "rehypothecation";

/**
 * One rung of the protection meter. `unknown` means the review could not
 * establish the fact; it is never the same as `failed` (known to be absent).
 */
export type CustodyProtectionState = "met" | "partial" | "failed" | "unknown";

export interface CustodyProtectionRung {
  key: CustodyProtectionKey;
  /** The protection, ≤ 3 words ("Bankruptcy-remote"). */
  label: string;
  state: CustodyProtectionState;
  /** The reviewed enum, in words ("Omnibus accounts", "Contractual only"). */
  valueLabel: string;
}

/**
 * - `provider` / `unidentified`: a disclosed share held by a named provider,
 *   or by an unnamed holder.
 * - `unsplit`: held by providers whose individual split is not disclosed.
 * - `unattributed`: shares that sum short of 100 % with nobody left to hold it.
 * - `undisclosed`: the reviewed share whose custodian is unknown.
 */
export type CustodyShareSegmentKind = "provider" | "unidentified" | "unsplit" | "unattributed" | "undisclosed";

export interface CustodyShareSegment {
  key: string;
  label: string;
  pct: number;
  kind: CustodyShareSegmentKind;
  /** Holder rows (named or unnamed) this segment covers, so they can carry its swatch. */
  providerKeys: string[];
}

export interface CustodyClientSummary {
  postureKey: CustodyPostureKey;
  /** Header and Evidence-index chip: sentence case, ≤ 30 characters. */
  postureLabel: string;
  postureToneClass: string;
  /** One generated sentence within the verdict budget; names stay in the chips. */
  summary: string;
  /** Named providers only: disclosed shares first (largest first), then the authored order. */
  providers: CustodyProviderClientRow[];
  /** Reviewed stand-ins for unnamed custodians, in the same order. */
  unnamedHolders: CustodyUnnamedHolderClientRow[];
  /** True when at least one holder row (named or unnamed) discloses a share. */
  sharesDisclosed: boolean;
  /**
   * The reviewed undisclosed share, only when it quantifies something: always
   * beside disclosed shares, and otherwise only strictly between 0 and 100.
   * Named providers with no disclosed split are "shares not disclosed", never
   * "100 % undisclosed exposure".
   */
  undisclosedSharePct: number | null;
  /** Stacked share bar segments; null when fewer than two segments exist. */
  shareSegments: CustodyShareSegment[] | null;
  /** Segregated → bankruptcy-remote → no rehypothecation, in that order. */
  protection: CustodyProtectionRung[];
  confidenceLabel: string;
  confidenceVerified: boolean;
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

const POSTURE_LABELS: Record<CustodyPostureKey, string> = {
  "segregated-remote": "Segregated, bankruptcy-remote",
  segregated: "Segregated",
  mixed: "Mixed accounts",
  omnibus: "Omnibus accounts",
  "partly-disclosed": "Partly disclosed",
  "structure-undisclosed": "Structure undisclosed",
  undisclosed: "Undisclosed",
};

// The tone follows the first rung's state in the meter (met → ok, partial →
// watch, failed → rose, as `custody-card.tsx` draws the rung text). The
// grade-only info blue never marks a state chip (DESIGN.md). Unknown reads as
// a dashed neutral pill, the page's grammar for "not established".
const UNKNOWN_POSTURE_TONE = `${SEVERITY_TONE_CLASS.neutral.pill} border-dashed`;
const POSTURE_TONES: Record<CustodyPostureKey, string> = {
  "segregated-remote": SEVERITY_TONE_CLASS.ok.pill,
  segregated: SEVERITY_TONE_CLASS.ok.pill,
  mixed: SEVERITY_TONE_CLASS.watch.pill,
  omnibus: SEVERITY_TONE_CLASS.rose.pill,
  "partly-disclosed": SEVERITY_TONE_CLASS.neutral.pill,
  "structure-undisclosed": UNKNOWN_POSTURE_TONE,
  undisclosed: UNKNOWN_POSTURE_TONE,
};

type RungReading = Pick<CustodyProtectionRung, "state" | "valueLabel">;

const UNKNOWN_RUNG: RungReading = { state: "unknown", valueLabel: "Unknown" };

const SEGREGATION_RUNG: Record<CustodySegregation, RungReading> = {
  segregated: { state: "met", valueLabel: "Segregated accounts" },
  mixed: { state: "partial", valueLabel: "Mixed accounts" },
  omnibus: { state: "failed", valueLabel: "Omnibus accounts" },
  unknown: UNKNOWN_RUNG,
};

const BANKRUPTCY_RUNG: Record<CustodyBankruptcyRemoteness, RungReading> = {
  structured: { state: "met", valueLabel: "Structural" },
  "contractual-only": { state: "partial", valueLabel: "Contractual only" },
  none: { state: "failed", valueLabel: "None" },
  unknown: UNKNOWN_RUNG,
};

const REHYPOTHECATION_RUNG: Record<CustodyRehypothecation, RungReading> = {
  prohibited: { state: "met", valueLabel: "Prohibited" },
  conditional: { state: "partial", valueLabel: "Conditional" },
  permitted: { state: "failed", valueLabel: "Permitted" },
  unknown: UNKNOWN_RUNG,
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

/**
 * Reviewed names that stand in for custodians nobody has named: "Undisclosed
 * Australian bank", "Reserve custodians and counterparties (not publicly
 * identified)", "Custodian(s) not publicly named in the June 2026 report". A
 * named entity whose *allocation* is undisclosed ("BitGo Trust Company, Inc.
 * (… allocation undisclosed)") stays a named provider.
 */
const UNIDENTIFIED_PROVIDER_PATTERN =
  /^(?:one or more |unverified and )?(?:undisclosed|unidentified|unnamed)\b|\bnot (?:publicly |individually |separately )?(?:identified|named|disclosed)\b|\bnames undisclosed\b|\(unnamed\)/i;

/** Contract and wallet addresses never reach the summary layer (summary budget). */
const RAW_ADDRESS = /\s*\b(?:0x[0-9a-fA-F]{6,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{25,})\b/g;

/** Drops one trailing balanced parenthetical ("BitGo Trust (… undisclosed)" → "BitGo Trust"); a linear scan, not a nested regex. */
function stripTrailingParenthetical(text: string): string {
  if (!text.endsWith(")")) return text;
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === ")") depth += 1;
    if (char !== "(") continue;
    depth -= 1;
    if (depth === 0) return text.slice(0, index).trimEnd();
  }
  return text;
}

function stripRawAddresses(name: string): string {
  return name.replace(RAW_ADDRESS, "").replace(/\s{2,}/g, " ").trim();
}

function shortProviderName(name: string): string {
  const withoutAddresses = stripRawAddresses(name);
  const head = stripTrailingParenthetical(withoutAddresses).replace(/[\s,;:]+$/, "").trim();
  return head || withoutAddresses || name;
}

/** Every reviewed holder row, named or not: shares and the verdict count both kinds. */
interface CustodyHolderRow extends CustodyProviderClientRow {
  identified: boolean;
}

/** `97.5%`, `100%`, `<0.1%`: one decimal at most, trailing `.0` dropped. */
export function formatCustodySharePct(pct: number): string {
  if (pct > 0 && pct < 0.05) return "<0.1%";
  const fixed = pct.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

/** Reads the chip off the meter, so the two can never disagree. */
function resolvePostureKey(protection: readonly CustodyProtectionRung[], namedCount: number): CustodyPostureKey {
  if (protection.every((rung) => rung.state === "unknown")) {
    return namedCount > 0 ? "structure-undisclosed" : "undisclosed";
  }
  const [segregation, bankruptcy] = protection;
  switch (segregation?.state) {
    case "met":
      return bankruptcy?.state === "met" ? "segregated-remote" : "segregated";
    case "partial":
      return "mixed";
    case "failed":
      return "omnibus";
    default:
      return "partly-disclosed";
  }
}

function resolveUndisclosedSharePct(profile: CustodyProfile, sharesDisclosed: boolean): number | null {
  const pct = profile.knownUnknownExposurePct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  if (sharesDisclosed) return pct;
  // Without one disclosed share, 100 only restates "the split is not
  // disclosed" and 0 has nothing to draw.
  return pct > 0 && pct < 100 ? pct : null;
}

/** Provider segments beyond this many merge into one "N other providers" segment. */
const MAX_PROVIDER_SEGMENTS = 4;
/** Shares are reviewed to ±0.5 pp (schema tolerance); smaller gaps are rounding. */
const SHARE_TOLERANCE_PCT = 0.5;

function buildShareSegments(
  providers: readonly CustodyHolderRow[],
  undisclosedSharePct: number | null,
): CustodyShareSegment[] | null {
  const shared = providers.filter((provider) => (provider.sharePct ?? 0) > 0);
  const segments: CustodyShareSegment[] = shared.slice(0, MAX_PROVIDER_SEGMENTS).map((provider) => ({
    key: provider.key,
    label: provider.shortName,
    pct: provider.sharePct!,
    kind: provider.identified ? "provider" : "unidentified",
    providerKeys: [provider.key],
  }));
  const rest = shared.slice(MAX_PROVIDER_SEGMENTS);
  if (rest.length > 0) {
    segments.push({
      key: "other-providers",
      label: `${rest.length} other ${rest.length === 1 ? "provider" : "providers"}`,
      pct: rest.reduce((total, provider) => total + provider.sharePct!, 0),
      kind: "provider",
      providerKeys: rest.map((provider) => provider.key),
    });
  }

  const sharedTotal = shared.reduce((total, provider) => total + provider.sharePct!, 0);
  const remainder = 100 - sharedTotal - (undisclosedSharePct ?? 0);
  if (remainder > SHARE_TOLERANCE_PCT) {
    const unsplit = providers.filter((provider) => provider.sharePct == null);
    segments.push(
      unsplit.length > 0
        ? {
            key: "split-not-disclosed",
            label: "Split not disclosed",
            pct: remainder,
            kind: "unsplit",
            providerKeys: unsplit.map((provider) => provider.key),
          }
        : { key: "unattributed", label: "Unattributed", pct: remainder, kind: "unattributed", providerKeys: [] },
    );
  }
  if (undisclosedSharePct != null && undisclosedSharePct > 0) {
    segments.push({ key: "undisclosed", label: "Undisclosed", pct: undisclosedSharePct, kind: "undisclosed", providerKeys: [] });
  }
  // One segment is a degenerate 100 % block; its figure belongs on the chip.
  return segments.length >= 2 ? segments : null;
}

/** The custody structure carries no established fact: the module degrades to its strip form. */
export function isCustodyStructureUndisclosed(summary: Pick<CustodyClientSummary, "protection">): boolean {
  return summary.protection.every((rung) => rung.state === "unknown");
}

/** The largest disclosed share, only when no tie or unknown remainder could exceed it. */
function resolveLeader(providers: readonly CustodyHolderRow[]): CustodyHolderRow | null {
  const ranked = providers.filter((provider) => provider.sharePct != null);
  const largest = ranked[0];
  if (!largest || largest.sharePct! <= 0 || largest.sharePct === ranked[1]?.sharePct) return null;
  const unknownShareBound = 100 - ranked.reduce((total, provider) => total + provider.sharePct!, 0);
  return ranked.length === providers.length || largest.sharePct! > unknownShareBound ? largest : null;
}

/**
 * The generated verdict. Provider names stay out of it: they are long, may
 * carry addresses, and the chips above already show them. Detail drops (the
 * largest share, then the rehypothecation sentence the meter also shows)
 * until the sentence fits the verdict budget.
 */
function composeSummary(profile: CustodyProfile, providers: readonly CustodyHolderRow[]): string {
  const identified = providers.filter((provider) => provider.identified).length;
  const named = identified === 1 ? "one named custody provider" : `${identified} named custody providers`;
  const lead =
    identified === 0
      ? "Reserve custodians are not publicly identified"
      : identified === providers.length
        ? `Reserves sit with ${named}`
        : `Reserves sit with ${named} and unidentified others`;
  const leader = providers.length > 1 ? resolveLeader(providers) : null;
  const leaderClause = leader?.identified ? `, the largest holding ${formatCustodySharePct(leader.sharePct!)}` : "";

  const segregation = SEGREGATION_CLAUSES[profile.segregation] ?? SEGREGATION_CLAUSES.unknown;
  const bankruptcy = BANKRUPTCY_CLAUSES[profile.bankruptcyRemoteness] ?? null;
  const structure = bankruptcy
    ? `${segregation}${profile.segregation === "unknown" ? "," : ""} ${bankruptcy}`
    : segregation;
  const rehypothecation = REHYPOTHECATION_SENTENCES[profile.rehypothecation] ?? null;

  const compose = (withLeader: boolean, withRehypothecation: boolean) => {
    const first = `${lead}${withLeader ? leaderClause : ""}; ${structure}.`;
    return withRehypothecation && rehypothecation ? `${first} ${rehypothecation}` : first;
  };
  const candidates = [compose(true, true), compose(false, true), compose(false, false)];
  return candidates.find((candidate) => findSummaryBudgetViolations(candidate).length === 0) ?? candidates.at(-1)!;
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
  // Single untrusted boundary: custodyProfile is typed as CustodyProfile, but
  // the client detail coin only ever passes through a projection built here —
  // an upstream caller supplying a malformed value must not crash the module,
  // matching the mint-authority reader's philosophy of validating at the one
  // place raw data enters. `providers` not being an array is the load-bearing
  // shape check: everything else below assumes it can be iterated.
  if (!profile || !Array.isArray(profile.providers)) return null;
  const holders: CustodyHolderRow[] = profile.providers
    .map((provider, index) => ({
      key: `${provider.name}:${index}`,
      name: provider.name,
      shortName: shortProviderName(provider.name),
      identified: !UNIDENTIFIED_PROVIDER_PATTERN.test(provider.name),
      roleLabel: ROLE_LABELS[provider.role] ?? provider.role,
      jurisdiction: provider.jurisdiction ?? null,
      sharePct: typeof provider.sharePct === "number" && Number.isFinite(provider.sharePct) ? provider.sharePct : null,
    }))
    .toSorted((left, right) => (right.sharePct ?? -1) - (left.sharePct ?? -1));
  const providers: CustodyProviderClientRow[] = holders
    .filter((holder) => holder.identified)
    .map(({ key, name, shortName, roleLabel, jurisdiction, sharePct }) => ({
      key,
      name,
      shortName,
      roleLabel,
      jurisdiction,
      sharePct,
    }));
  const unnamedHolders: CustodyUnnamedHolderClientRow[] = holders
    .filter((holder) => !holder.identified)
    .map(({ key, name, sharePct }) => ({ key, description: stripRawAddresses(name) || name, sharePct }));
  const sharesDisclosed = holders.some((holder) => holder.sharePct != null);
  const undisclosedSharePct = resolveUndisclosedSharePct(profile, sharesDisclosed);
  const protection: CustodyProtectionRung[] = [
    { key: "segregation", label: "Segregated", ...(SEGREGATION_RUNG[profile.segregation] ?? UNKNOWN_RUNG) },
    {
      key: "bankruptcy-remoteness",
      label: "Bankruptcy-remote",
      ...(BANKRUPTCY_RUNG[profile.bankruptcyRemoteness] ?? UNKNOWN_RUNG),
    },
    {
      key: "rehypothecation",
      label: "No rehypothecation",
      ...(REHYPOTHECATION_RUNG[profile.rehypothecation] ?? UNKNOWN_RUNG),
    },
  ];
  const postureKey = resolvePostureKey(protection, providers.length);
  return {
    postureKey,
    postureLabel: POSTURE_LABELS[postureKey],
    postureToneClass: POSTURE_TONES[postureKey],
    summary: composeSummary(profile, holders),
    providers,
    unnamedHolders,
    sharesDisclosed,
    undisclosedSharePct,
    shareSegments: buildShareSegments(holders, undisclosedSharePct),
    protection,
    confidenceLabel: RESEARCH_REVIEW_CONFIDENCE_LABELS[profile.confidence],
    confidenceVerified: profile.confidence === "verified",
    uncertainty: profile.uncertainty || null,
    reviewedAt: profile.reviewedAt,
    sources: dedupeStablecoinLinksByUrl(profile.sources ?? []),
  };
}
