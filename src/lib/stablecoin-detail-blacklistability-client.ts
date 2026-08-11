import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import type { StablecoinLink, StablecoinMeta } from "@shared/types";
import { isRecord, stringValue } from "@shared/lib/type-guards";

/**
 * Client-safe projection of the server-only `blacklistabilityReview`, in the
 * `projectBridgeRouteRiskClientSummary` pattern: bounded labels plus the
 * review's own evidence prose and citations. The reviewer identity stays
 * server-side; the module renders the freeze/seizure power itself, not the
 * on-chain freeze events `BlacklistSection` already draws.
 *
 * Every field is read through a guard rather than trusted from the type: the
 * client-coin builder projects before stripping, and the stripping contract is
 * tested with a malformed sentinel review object.
 */
export type BlacklistabilityClientStatus = "freezable" | "not-freezable" | "possible" | "inherited";

export interface BlacklistabilityClientSummary {
  status: BlacklistabilityClientStatus;
  statusLabel: string;
  statusToneClass: string;
  /** One-line reading of the status, naming the upstream issuer when inherited. */
  statusNote: string;
  evidence: string;
  /** How the status was established: cited sources, a rationale, or neither. */
  basisLabel: string;
  sourceFreeRationale: string | null;
  /** Upstream coin name (or id) when the freeze power sits with a parent asset. */
  upstreamLabel: string | null;
  sources: StablecoinLink[];
  reviewedAt: string | null;
}

const STATUS_LABELS: Record<BlacklistabilityClientStatus, string> = {
  freezable: "Freezable",
  "not-freezable": "Not freezable",
  possible: "Possible",
  inherited: "Inherited",
};

const STATUS_TONES: Record<BlacklistabilityClientStatus, SeverityTone> = {
  freezable: "watch",
  "not-freezable": "ok",
  possible: "watch",
  inherited: "info",
};

function statusValue(value: unknown): BlacklistabilityClientStatus | null {
  if (value === true) return "freezable";
  if (value === false) return "not-freezable";
  if (value === "possible") return "possible";
  if (value === "inherited") return "inherited";
  return null;
}

function sourceList(value: unknown): StablecoinLink[] {
  if (!Array.isArray(value)) return [];
  const sources: StablecoinLink[] = [];
  for (const source of value) {
    if (!isRecord(source)) continue;
    const label = stringValue(source.label);
    const url = stringValue(source.url);
    if (label && url) sources.push({ label, url });
  }
  return sources;
}

/**
 * The upstream asset a freeze power is inherited from. `variantOf` is the
 * wrapper relationship; `mintAuthority.inheritedFrom` covers reviewed
 * inheritance without a variant edge. Roughly half of the inherited reviews
 * carry neither — those are protocol tokens whose exposure runs through a
 * collateral basket rather than one named issuer, and their evidence prose
 * carries the explanation instead.
 */
function resolveUpstream(coin: StablecoinMeta, parentById?: ReadonlyMap<string, StablecoinMeta>): string | null {
  const mintAuthority = isRecord(coin.mintAuthority) ? coin.mintAuthority : null;
  const upstreamId = stringValue(coin.variantOf) ?? stringValue(mintAuthority?.inheritedFrom);
  if (!upstreamId) return null;
  return stringValue(parentById?.get(upstreamId)?.name) ?? upstreamId;
}

function buildStatusNote(status: BlacklistabilityClientStatus, upstreamLabel: string | null): string {
  switch (status) {
    case "freezable":
      return "A reviewed issuer or protocol control can freeze or seize this token in holders' wallets.";
    case "not-freezable":
      return "The reviewed deployments expose no issuer freeze, seizure, or holder blacklist path.";
    case "possible":
      return "A freeze or seizure path is plausible but was not established across the reviewed deployments.";
    case "inherited":
      return upstreamLabel
        ? `Freeze power sits upstream with ${upstreamLabel} rather than in this token's own contract.`
        : "Freeze power sits upstream in the assets this token depends on rather than in its own contract.";
  }
}

export function projectBlacklistabilityClientSummary(
  coin: StablecoinMeta,
  parentById?: ReadonlyMap<string, StablecoinMeta>,
): BlacklistabilityClientSummary | null {
  const review = isRecord(coin.blacklistabilityReview) ? coin.blacklistabilityReview : null;
  if (!review) return null;

  const status = statusValue(review.reviewedStatus);
  const evidence = stringValue(review.evidence);
  if (!status || !evidence) return null;

  const sources = sourceList(review.sources);
  const sourceFreeRationale = stringValue(review.sourceFreeRationale);
  const upstreamLabel = status === "inherited" ? resolveUpstream(coin, parentById) : null;

  return {
    status,
    statusLabel: STATUS_LABELS[status],
    statusToneClass: SEVERITY_TONE_CLASS[STATUS_TONES[status]].pill,
    statusNote: buildStatusNote(status, upstreamLabel),
    evidence,
    basisLabel: sources.length > 0 ? "Sourced review" : sourceFreeRationale ? "Rationale only" : "Unsourced",
    sourceFreeRationale,
    upstreamLabel,
    sources,
    reviewedAt: stringValue(review.reviewedAt),
  };
}
