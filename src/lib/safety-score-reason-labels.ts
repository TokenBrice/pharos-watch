import { normalizeChain, prettifyProtocol } from "@/lib/dex-display-constants";
import { describeFailureDomain } from "@/lib/failure-domains";

/**
 * Reader label for a scored exit route. DEX routes arrive labelled with
 * internal ordinals ("Ethereum AMM 10"); the capacity record names the venue,
 * so they read "Curve on Ethereum", or "DEX pool on Ethereum" without one.
 */
export function describeExitRouteVenue(route: {
  label: string;
  routeFamily: string;
  capacity?: { chain: string | null; protocol: string | null } | null;
}): string {
  if (!route.routeFamily.startsWith("dex")) return route.label;
  const chain = route.capacity?.chain ?? /^(\S+) AMM\b/.exec(route.label)?.[1] ?? null;
  const protocol = route.capacity?.protocol;
  const venue = protocol ? prettifyProtocol(protocol) : "DEX pool";
  return chain ? `${venue} on ${normalizeChain(chain)}` : venue;
}

/**
 * Render-time humanization of Safety Score evaluator reasons (dossier UX D13).
 *
 * The evaluator writes reasons for auditability: they embed machine keys
 * (`chain:solana`, `bridge-meta:<coin>:<hash>`, `mechanism:loss-absorption`),
 * camelCase datum names (`materialSupplyShare`) and version pins. Published
 * payloads stay unchanged; this module maps them to reader-facing wording and
 * folds identical reasons ("Bridged supply share unresolved on 25 bridge
 * routes") so one unresolved datum class cannot fill a card 25 times over.
 */

/** Visible reasons per list; the rest fold behind a disclosure. */
export const SAFETY_SCORE_VISIBLE_REASON_LIMIT = 3;

const DATUM_LABELS: Record<string, string> = {
  materialSupplyShare: "bridged supply share",
  incidentState: "incident state",
  keyCustody: "key custody",
  executionScope: "execution scope",
  capAuthority: "cap authority",
  claimImpairment: "claim impairment",
  settlement: "settlement time",
  observationConfidence: "observation confidence",
  shareAccountingNavOracle: "share accounting and NAV oracle",
  lossAbsorptionEmergencyControls: "loss absorption and emergency controls",
  assuranceAndReconciliation: "assurance and reconciliation",
  encumbranceAndAllocation: "encumbrance and allocation",
  claimAndSegregation: "claim and segregation",
  navValuation: "NAV valuation",
};

const ROUTE_TYPE_LABELS: Record<string, string> = {
  "offchain-issuer": "issuer redemption",
  "collateral-redeem": "collateral redemption",
  collate: "collateral redemption",
  "queue-redeem": "queued redemption",
  "basket-redeem": "basket redemption",
  "stablecoin-redeem": "stablecoin redemption",
  "psm-swap": "PSM swap",
  "physical-to-usd": "physical redemption",
};

/**
 * Embedded evaluator keys. `.` is excluded so a sentence period never joins the
 * key; segments are one flat character class (no nested quantifiers), and a
 * trailing `:` is handed back to the sentence by `describeKeyToken`.
 */
const EVALUATOR_KEY_PATTERN =
  /\b(?:chain|bridge-meta|bridge-route|mint-meta|mint-control|upgrade-control|mechanism|oracle|redemption-rail|redemption|dex-protocol|dex|common-mode|venue|reserve):[A-Za-z0-9%_~+:-]+/g;
const CAMEL_CASE_PATTERN = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const VERSION_PIN_PATTERN = /\bv\d+(?:\.\d)?\d*\s+/g;

function describeKeyToken(token: string): string {
  const key = token.replace(/:+$/, "");
  return `${describeEvaluatorKey(key)}${token.slice(key.length)}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function slugWords(slug: string): string {
  return slug.replace(/[-_]+/g, " ").trim();
}

/** `materialSupplyShare` → "bridged supply share"; unknown camelCase splits to words. */
function describeEvidenceDatum(datum: string): string {
  const explicit = DATUM_LABELS[datum];
  if (explicit) return explicit;
  return datum.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase();
}

interface KeyNoun {
  /** Label for a single key, usable mid-sentence ("a bridge route", "Solana"). */
  one: string;
  /** Plural noun for grouped counts ("bridge routes"); null when the key names one thing. */
  many: string | null;
  /** Grouping class: keys of the same class fold into one counted line. */
  kind: string;
}

function describeRouteKey(key: string): KeyNoun {
  const parts = key.split(":");
  const executionIndex = parts.indexOf("execution");
  if (executionIndex >= 0) {
    return { one: "a redemption execution", many: "redemption executions", kind: "route:execution" };
  }
  if (parts[0] === "dex") return { one: "a DEX route", many: "DEX routes", kind: "route:dex" };
  // `redemption:redemption:<uuid>:redemption:<coin>:<route-type>` — the route type
  // is the segment after the coin id.
  const lastRedemption = parts.lastIndexOf("redemption");
  const routeType = lastRedemption >= 0 ? parts[lastRedemption + 2] : undefined;
  const label = routeType === undefined ? null : ROUTE_TYPE_LABELS[routeType] ?? slugWords(routeType);
  if (label === null) return { one: "a redemption route", many: "redemption routes", kind: "route:redemption" };
  return { one: `the ${label} route`, many: `${label} routes`, kind: `route:${routeType}` };
}

function describeKeyNoun(key: string): KeyNoun {
  if (key.startsWith("chain:")) return { one: describeFailureDomain(key).label, many: null, kind: key };
  if (key.startsWith("bridge-meta:")) return { one: "a bridge route", many: "bridge routes", kind: "bridge-meta" };
  if (key.startsWith("mint-meta:")) return { one: "a mint control", many: "mint controls", kind: "mint-meta" };
  if (key.startsWith("bridge-route:")) {
    // Protocol routes name one bridge; contract/authority routes fold together.
    const isProtocol = key.split("+").some((part) => part.startsWith("bridge-route:protocol:"));
    return isProtocol
      ? { one: describeFailureDomain(key).label, many: null, kind: key }
      : { one: describeFailureDomain(key).label, many: "bridge contracts", kind: "bridge-route" };
  }
  if (key.startsWith("mechanism:")) {
    return { one: `the ${slugWords(key.slice("mechanism:".length))} review`, many: null, kind: key };
  }
  if (key.startsWith("oracle:")) {
    return { one: `the ${slugWords(key.slice("oracle:".length))} oracle`, many: null, kind: key };
  }
  // `dex-protocol:<venue>` is a failure domain (a named venue); `dex:` is a route key.
  if (key.startsWith("dex-protocol:")) {
    return { one: `the ${prettifyProtocol(key.slice("dex-protocol:".length))} venue`, many: null, kind: key };
  }
  if (key.startsWith("redemption:") || key.startsWith("dex:")) return describeRouteKey(key);
  if (key.startsWith("mint-control:")) return { one: "a mint control", many: "mint controls", kind: "mint-control" };
  if (key.startsWith("upgrade-control:")) return { one: "an upgrade control", many: "upgrade controls", kind: "upgrade-control" };
  if (key.startsWith("redemption-rail:")) {
    return { one: `the ${slugWords(key.slice("redemption-rail:".length))} redemption rail`, many: null, kind: key };
  }
  if (key.startsWith("common-mode:reserve-issuer:")) {
    return { one: "a shared reserve issuer", many: "shared reserve issuers", kind: "common-mode:reserve-issuer" };
  }
  if (key.startsWith("venue:")) return { one: `the ${slugWords(key.slice("venue:".length))} venue`, many: null, kind: key };
  if (key.startsWith("reserve:")) return { one: "a reserve slice", many: "reserve slices", kind: "reserve" };
  return { one: "an evaluated input", many: "evaluated inputs", kind: key.split(":")[0] ?? key };
}

/** Reader-facing label for one evaluator key (`chain:solana` → "Solana"). */
export function describeEvaluatorKey(key: string): string {
  return describeKeyNoun(key).one;
}

function roundLongDecimals(text: string): string {
  return text.replace(/\d+\.\d{4,}/g, (value) => Number(value).toFixed(3));
}

/** Inline fallback: resolve keys, split camelCase datums, drop version pins. */
function humanizeInline(message: string): string {
  return roundLongDecimals(message)
    .replace(EVALUATOR_KEY_PATTERN, describeKeyToken)
    .replace(CAMEL_CASE_PATTERN, (token) => describeEvidenceDatum(token))
    .replace(VERSION_PIN_PATTERN, "")
    .trim();
}

interface HumanizedReason {
  groupKey: string;
  one: string;
  many: ((count: number) => string) | null;
}

function humanizeReasonParts(rawMessage: string): HumanizedReason {
  const message = rawMessage.trim();

  const controlDatum = /^The (\w+) datum for independently identified control (\S+?) remains unresolved\.?$/.exec(message);
  if (controlDatum) {
    const datum = capitalize(describeEvidenceDatum(controlDatum[1]!));
    const noun = describeKeyNoun(controlDatum[2]!);
    return {
      groupKey: `control-datum:${controlDatum[1]}:${noun.kind}`,
      one: `${datum} unresolved for ${noun.one}`,
      many: noun.many === null ? null : (count) => `${datum} unresolved on ${count} ${noun.many}`,
    };
  }

  const routeDatum = /^The (\w+) datum for route (\S+?) has not been established\.?$/.exec(message);
  if (routeDatum) {
    const datum = capitalize(describeEvidenceDatum(routeDatum[1]!));
    const noun = describeKeyNoun(routeDatum[2]!);
    return {
      groupKey: `route-datum:${routeDatum[1]}:${noun.kind}`,
      one: `${datum} not established for ${noun.one}`,
      many: noun.many === null ? null : (count) => `${datum} not established on ${count} ${noun.many}`,
    };
  }

  const condition = /^([a-z][a-z-]*) condition at (\S+?)\.?$/.exec(message);
  if (condition) {
    const text = `${capitalize(slugWords(condition[1]!))} condition flagged in ${describeEvaluatorKey(condition[2]!)}`;
    return { groupKey: text, one: text, many: null };
  }

  const ownShare =
    /^This asset's own reviewed share is ([\d.]+%) at (\S+?), (.+?) \(also (\d+) reviewed paths across (\d+) (assets|independent root liabilities) share [^)]+\)\.?$/
      .exec(message);
  if (ownShare) {
    const [, share, key, qualifier, paths, holders, holderNoun] = ownShare;
    const text = `${describeCommonModeShare(share!, key!, qualifier!)}, shared by ${paths} paths across ${holders} ${
      holderNoun === "assets" ? "assets" : "issuers"
    }`;
    return { groupKey: text, one: text, many: null };
  }

  const unpublishedInput = /^Reviewed (\d{4}-\d{2}-\d{2}): the (\w+) input is not published by the issuer\./.exec(message);
  if (unpublishedInput) {
    const text = `${capitalize(describeEvidenceDatum(unpublishedInput[2]!))} is not published by the issuer (reviewed ${unpublishedInput[1]})`;
    return { groupKey: text, one: text, many: null };
  }

  const staleReview = /^The (\S+?) (mechanism|economic-control) review is not a current known fact\.?$/.exec(message);
  if (staleReview) {
    const subject = staleReview[1]!;
    const label = subject.includes(":")
      ? describeEvaluatorKey(subject).replace(/^the /, "")
      : describeEvidenceDatum(subject);
    const kind = staleReview[2] === "mechanism" ? "review" : "control review";
    const text = `${capitalize(label)} ${kind} is not yet current`;
    return { groupKey: text, one: text, many: null };
  }

  const wrapperDiscount = /^Reviewed wrapper-local (\w+) risk contributes ([\d.]+) discount points\.?$/.exec(message);
  if (wrapperDiscount) {
    const text = `Wrapper ${describeEvidenceDatum(wrapperDiscount[1]!)} risk costs ${roundLongDecimals(wrapperDiscount[2]!)} points`;
    return { groupKey: text, one: text, many: null };
  }

  const wrapperFallback = /^Wrapper-local (\w+) is ([\w-]+); the [\w-]+ fallback discount bounds the unresolved local layer\.?$/.exec(message);
  if (wrapperFallback) {
    const text = `Wrapper ${describeEvidenceDatum(wrapperFallback[1]!)} is ${slugWords(wrapperFallback[2]!)}; a standard discount covers it`;
    return { groupKey: text, one: text, many: null };
  }

  // Unrecognized reasons keep their producer wording and punctuation; only
  // embedded keys, camelCase datums and version pins are rewritten.
  const text = humanizeInline(message);
  return { groupKey: text, one: text, many: null };
}

/**
 * The evaluator's common-mode share is not always a measurement: for chain
 * domains it is the conservative upper bound of reviewed exposure, and every
 * share is deployment- or access-scoped, never a claim on reserves. The
 * producer's qualifier (`commonModeReasonQualifier` in evaluate-set.ts) carries
 * the bound, the severity band and the scope, so the reader text keeps all three.
 *
 * DEX venues use a different denominator: `summarizeDexDomainExposure` divides
 * the venue's executable capacity by the policy's reference exit request, not
 * by supply, and the reason cites the `.upper` bound (1 until every route is
 * complete and current), so it always reads as an upper bound on coverage.
 */
function describeCommonModeShare(share: string, key: string, qualifier: string): string {
  const name = describeEvaluatorKey(key);
  const range = /from ([\d.]+%) to below ([\d.]+%)/.exec(qualifier);
  const floor = /at or above ([\d.]+%)/.exec(qualifier);
  const band = range ? `${range[1]}–${range[2]} band` : floor ? `at or above the ${floor[1]} threshold` : null;
  if (key.startsWith("dex-protocol:")) {
    const notes = ["upper bound", "exit-access exposure", band].filter(Boolean).join("; ");
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} can fill up to ${share} of the reference exit request (${notes})`;
  }
  const upperBound = /\bupper bound\b/.test(qualifier);
  const [verb, scope] = key.startsWith("chain:")
    ? [`is deployed on ${name}`, "deployment exposure"]
    : key.startsWith("bridge-route:")
      ? [`relies on ${name} for bridging`, "deployment exposure"]
      : key.startsWith("mint-control:") || key.startsWith("upgrade-control:")
        ? [`sits on deployments controlled by ${name}`, "deployment exposure"]
        : [`is exposed to ${name}`, /\bdeployment\b/.test(qualifier) ? "deployment exposure" : "reviewed exposure"];
  const notes = [upperBound ? "conservative upper bound" : null, scope, band].filter(Boolean).join("; ");
  return `${upperBound ? "Up to " : ""}${share} of reviewed supply ${verb} (${notes})`;
}

/** One reason, rewritten for readers. */
export function humanizeSafetyScoreReason(message: string): string {
  return humanizeReasonParts(message).one;
}

export interface SafetyScoreReasonGroup {
  key: string;
  text: string;
  count: number;
}

/**
 * Humanize and fold reasons. Repeated raw messages count once (one reason can
 * reach a surface through both a pillar and the score attribution); reasons of
 * one template and key class collapse to one counted line; identical rewritten
 * lines collapse to one. Order follows first occurrence.
 */
export function groupSafetyScoreReasons(messages: readonly string[]): SafetyScoreReasonGroup[] {
  const groups = new Map<string, { parts: HumanizedReason; count: number }>();
  for (const message of new Set(messages.map((raw) => raw.trim()))) {
    if (message.length === 0) continue;
    const parts = humanizeReasonParts(message);
    const existing = groups.get(parts.groupKey);
    if (existing) existing.count += 1;
    else groups.set(parts.groupKey, { parts, count: 1 });
  }
  return [...groups.entries()].map(([key, { parts, count }]) => ({
    key,
    text: count > 1 && parts.many !== null ? parts.many(count) : parts.one,
    count,
  }));
}

/**
 * Excluded score component keys (`partialEvidence.excludedComponentKeys`) in
 * plain words, e.g. the USDC issuer-redemption cost gap → "issuer redemption cost".
 */
export function describeExcludedScoreComponent(key: string): string {
  if (key === "dependency:parent") return "the parent asset's score";
  if (key.startsWith("wrapper-local:")) return `wrapper ${describeEvidenceDatum(key.slice("wrapper-local:".length))}`;
  if (key.startsWith("mechanism:")) return `${slugWords(key.slice("mechanism:".length))} review`;
  if (key.startsWith("reserve:")) return `reserve ${slugWords(key.slice("reserve:".length))}`;
  if (key.startsWith("redemption:") || key.startsWith("dex:")) {
    const parts = key.split(":");
    if (parts.includes("execution")) return "redemption execution evidence";
    const lastRedemption = parts.lastIndexOf("redemption");
    const routeType = lastRedemption >= 0 ? parts[lastRedemption + 2] : undefined;
    const datum = lastRedemption >= 0 ? parts[lastRedemption + 3] : undefined;
    const routeLabel = routeType === undefined
      ? parts[0] === "dex" ? "DEX route" : "redemption route"
      : ROUTE_TYPE_LABELS[routeType] ?? slugWords(routeType);
    return datum === undefined ? `${routeLabel} route` : `${routeLabel} ${describeEvidenceDatum(datum)}`;
  }
  return "an evidence input";
}

const PARTIAL_EVIDENCE_CAUSE_LABELS: Record<string, string> = {
  A: "data pipeline unavailable",
  B: "public data awaiting curation",
};

export interface PartialEvidenceDescription {
  /** One plain sentence naming what is excluded and why. */
  summary: string;
  /** Machine-readable reason code (data-integrity R3/R4). */
  reasonCode: string;
}

export function describePartialEvidence(partial: {
  reasonCode: string;
  excludedPillars: readonly string[];
  excludedComponentKeys: readonly string[];
  causes: readonly string[];
}): PartialEvidenceDescription {
  // Component keys under an excluded pillar (`backing:reviewed`) restate the
  // pillar, so only components of included pillars are named separately.
  const excludedPillars = new Set(partial.excludedPillars);
  const excluded = [
    ...partial.excludedPillars.map((pillar) => `the ${pillar} pillar`),
    ...new Set(partial.excludedComponentKeys
      .filter((key) => !excludedPillars.has(key.split(":")[0] ?? ""))
      .map(describeExcludedScoreComponent)),
  ];
  const causes = partial.causes.map((cause) => PARTIAL_EVIDENCE_CAUSE_LABELS[cause] ?? "evidence unavailable");
  const subject = excluded.length === 0 ? "Some evidence" : capitalize(excluded.join(", "));
  const verb = excluded.length > 1 ? "are" : "is";
  return {
    summary: `${subject} ${verb} left out of the score for now (${causes.join("; ")}); the remaining inputs carry ${
      excluded.length > 1 ? "their" : "its"
    } weight.`,
    reasonCode: partial.reasonCode,
  };
}
