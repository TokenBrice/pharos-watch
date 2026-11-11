import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import type { StablecoinLink, StablecoinMeta } from "@shared/types";
import { isRecord, stringValue } from "@shared/lib/type-guards";
import { readStablecoinLinks } from "@/lib/stablecoin-detail-links-client";

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
  /** Upstream coin name when the freeze power sits with a tracked parent asset; never a raw id. */
  upstreamLabel: string | null;
  sources: StablecoinLink[];
  reviewedAt: string | null;
}

const STATUS_LABELS: Record<BlacklistabilityClientStatus, string> = {
  freezable: "Freezable",
  "not-freezable": "Not freezable",
  possible: "Possible",
  inherited: "Upstream",
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

/**
 * The upstream asset a freeze power is inherited from. `variantOf` is the
 * wrapper relationship; `mintAuthority.inheritedFrom` covers reviewed
 * inheritance without a variant edge. Roughly half of the inherited reviews
 * carry neither — those are protocol tokens whose exposure runs through a
 * collateral basket rather than one named issuer, and their evidence prose
 * carries the explanation instead. A parent the registry does not track has
 * no reader name, so it resolves to null rather than leaking its coin id.
 */
function resolveUpstream(coin: StablecoinMeta, parentById?: ReadonlyMap<string, StablecoinMeta>): string | null {
  const mintAuthority = isRecord(coin.mintAuthority) ? coin.mintAuthority : null;
  const upstreamId = stringValue(coin.variantOf) ?? stringValue(mintAuthority?.inheritedFrom);
  if (!upstreamId) return null;
  return stringValue(parentById?.get(upstreamId)?.name);
}

interface FreezeControlDescriptor {
  status: BlacklistabilityClientStatus | null;
  deploymentScope: "material-deployments" | null;
  inheritedSource: { label: string | null } | null;
}

export function buildFreezeControlDescriptor(
  coin: StablecoinMeta,
  value: unknown,
  parentById?: ReadonlyMap<string, StablecoinMeta>,
): FreezeControlDescriptor {
  const status = statusValue(value);
  return {
    status,
    deploymentScope: status === "possible" || status === "not-freezable" ? "material-deployments" : null,
    inheritedSource: status === "inherited" ? { label: resolveUpstream(coin, parentById) } : null,
  };
}

/** Static sentence/FAQ, compact safety fact and live note share one interpretation. */
export function describeFreezeControl(descriptor: FreezeControlDescriptor) {
  const scope = descriptor.deploymentScope === "material-deployments" ? "material deployments" : "deployments";
  switch (descriptor.status) {
    case "freezable":
      return {
        sentence: "issuer or admin freeze controls are recorded",
        compact: "the issuer or an admin can freeze individual holders' balances",
        note: "A reviewed issuer or protocol control can freeze or seize this token in holders' wallets.",
      };
    case "not-freezable":
      return {
        sentence: "no direct freeze-control path sets the verdict under the reviewed deployment-materiality scope",
        compact: `no direct power to freeze holders was found on its ${scope}`,
        note: "Under the reviewed deployment-materiality scope, no issuer freeze, seizure, or holder blacklist path sets the verdict. Peripheral deployment controls, if any, are described in the review notes.",
      };
    case "possible":
      return {
        sentence: `admin controls such as a global pause or an upgradeable contract are recorded, but the review found no active power to freeze or seize a specific holder's balance on ${scope}`,
        compact: `admin controls such as a pause or an upgradeable contract exist, though no power to freeze a specific holder was found on its ${scope}`,
        note: `An admin control could restrict holders, but the review found no active power to freeze or seize a specific holder's balance on its ${scope}. Typical cases are a global transfer pause, an upgradeable token contract, or a blacklist role that exists but is unassigned.`,
      };
    case "inherited":
      return {
        sentence: "freeze exposure is inherited through upstream collateral, custody, or wrapper dependencies",
        compact: "freeze exposure is inherited through upstream collateral, custody or wrappers",
        note: descriptor.inheritedSource?.label
          ? `Freeze power sits upstream with ${descriptor.inheritedSource.label} rather than in this token's own contract.`
          : "Freeze power sits upstream in the assets this token depends on rather than in its own contract.",
      };
    default:
      return {
        sentence: "freeze-control coverage is not conclusive from static metadata alone",
        compact: null,
        note: "freeze-control coverage is not conclusive from static metadata alone",
      };
  }
}

export function projectBlacklistabilityClientSummary(
  coin: StablecoinMeta,
  parentById?: ReadonlyMap<string, StablecoinMeta>,
): BlacklistabilityClientSummary | null {
  const review = isRecord(coin.blacklistabilityReview) ? coin.blacklistabilityReview : null;
  if (!review) return null;

  const descriptor = buildFreezeControlDescriptor(coin, review.reviewedStatus, parentById);
  const { status } = descriptor;
  const evidence = stringValue(review.evidence);
  if (!status || !evidence) return null;

  const sources = readStablecoinLinks(review.sources);
  const sourceFreeRationale = stringValue(review.sourceFreeRationale);
  const upstreamLabel = descriptor.inheritedSource?.label ?? null;

  return {
    status,
    statusLabel: STATUS_LABELS[status],
    statusToneClass: SEVERITY_TONE_CLASS[STATUS_TONES[status]].pill,
    statusNote: describeFreezeControl(descriptor).note,
    evidence,
    basisLabel: sources.length > 0 ? "Sourced review" : sourceFreeRationale ? "Rationale only" : "Unsourced",
    sourceFreeRationale,
    upstreamLabel,
    sources,
    reviewedAt: stringValue(review.reviewedAt),
  };
}
