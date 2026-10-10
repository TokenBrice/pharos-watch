// src/lib/regulatory-standing.ts
import type {
  GeniusAuthorizationStatus,
  GeniusProfile,
  MicaProfile,
  MicaStatus,
  StablecoinMeta,
} from "@shared/types";
import { POR_BADGE_STYLES, POR_TIER_STYLES } from "@shared/lib/classification";
import {
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
  GENIUS_ISSUER_PATHWAY_LABELS,
  GENIUS_STATUS_SHORT_LABELS,
} from "@shared/lib/genius";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
  MICA_TOKEN_TYPE_LABELS,
} from "@shared/lib/mica";

/**
 * On-page view of the coin's regulatory standing across the GENIUS (US) and
 * MiCA (EU) regimes: one row per regime that applies (status pill +
 * pathway/token-type caption), then what the issuer publishes (reserve
 * attestation / redemption policy / reserve disclosure) as a separate
 * issuer-level row, with regulator facts, the latest report note, review
 * notes and sources for the fold. Pure derivation from the client coin — no
 * fetch, no server-only imports.
 *
 * The disclosures are deliberately not regime cells: they describe what the
 * issuer publishes, not compliance with either regime, so a "None found"
 * GENIUS status can sit above three published disclosures without either
 * fact contradicting the other. The attestation cell reads the coin's
 * proof-of-reserves record first, the same fact the hero passport's Attestor
 * entry shows, so the page never says "Not found" beside a named attestor.
 */
export interface RegulatoryFact {
  key: string;
  label: string;
  value: string;
  valueClassName?: string;
  href?: string;
  /** Full untruncated value, e.g. the original regulator prose before slicing. */
  title?: string;
}

export type IssuerDisclosureKey = "attestation" | "redemption-policy" | "reserve-disclosure";

export interface IssuerDisclosure {
  key: IssuerDisclosureKey;
  label: string;
  /** Visible label in the disclosures row; one or two words. */
  shortLabel: string;
}

/** The issuer disclosures the row shows, in fixed display order. */
export const ISSUER_DISCLOSURES: readonly IssuerDisclosure[] = [
  { key: "attestation", label: "Reserve attestation", shortLabel: "Attestation" },
  { key: "redemption-policy", label: "Redemption policy", shortLabel: "Redemption" },
  { key: "reserve-disclosure", label: "Reserve disclosure", shortLabel: "Reserves" },
];

/**
 * `published` the issuer publishes it; `gap` reviewed and not found, or an
 * attestation short of the monthly, independent report GENIUS requires;
 * `unrecorded` no record: unavailable, never a failure.
 */
export type IssuerDisclosureState = "published" | "gap" | "unrecorded";

export interface IssuerDisclosureRow extends IssuerDisclosure {
  state: IssuerDisclosureState;
  /** Visible value: the state in words, or the attestation cadence when the reserves record has one. */
  value: string;
  /** Hover detail behind the value: who attests, and how often. */
  title?: string;
  href?: string;
}

export interface RegulatoryStatus {
  /** Sentence-case status, e.g. "Non-compliant", "None found". */
  label: string;
  /** Pill tone from the regime's shared badge styles (out-of-scope is muted). */
  toneClass: string;
  /** What the status means; the pill tooltip. */
  description: string;
}

export interface RegulatoryRegimeView {
  key: "genius" | "mica";
  /** Full name, e.g. "GENIUS (US)". */
  regimeLabel: string;
  /** Row header, e.g. "GENIUS". */
  shortLabel: string;
  /** Row header sub-label, e.g. "US". */
  jurisdiction: string;
  status: RegulatoryStatus;
  /** Issuer pathway (GENIUS) or token type (MiCA); null when none is recorded. */
  caption: string | null;
  /** Detail facts for the fold (regulator, competent authority). */
  facts: RegulatoryFact[];
}

export interface RegulatoryStandingView {
  badgeLabel: string;
  badgeToneClass: string;
  summary: string;
  regimes: RegulatoryRegimeView[];
  /**
   * One row per `ISSUER_DISCLOSURES` entry, in order, when a GENIUS review
   * recorded them; empty without one (MiCA does not track them).
   */
  issuerDisclosures: IssuerDisclosureRow[];
  /** Latest reserve report dates behind the reserve disclosure. */
  reportNote: string | null;
  /** Reviewer narrative from the GENIUS review. */
  notes: string | null;
  sources: { label: string; url: string }[];
  reviewedAt: string | null;
}

const GENIUS_SUMMARY_CLAUSES: Record<GeniusAuthorizationStatus, string> = {
  "ppsi-approved": "is federally approved as a permitted payment stablecoin issuer under the GENIUS Act",
  "state-qualified": "is state-qualified under the GENIUS Act",
  "official-application-pending": "has a GENIUS authorization filing pending",
  "issuer-announced-intent": "has public materials signalling a GENIUS-era issuance path",
  "no-public-authorization-found": "has no public GENIUS authorization on record",
  "not-applicable": "sits outside the GENIUS Act's scope",
  unknown: "has an unreviewed GENIUS status",
};

const MICA_SUMMARY_CLAUSES: Record<MicaStatus, string> = {
  authorized: "is MiCA-authorized for the EU",
  pending: "has a MiCA authorization pending",
  transitional: "trades in the EU under transitional MiCA cover",
  "non-compliant": "lacks MiCA authorization for EU venues",
  "out-of-scope": "is out of MiCA scope",
};

/**
 * Sentence case for the shared Title Case status vocabularies (plan §8c):
 * every word after the first is lowercased unless it is an acronym, so
 * "Non-Compliant" reads "Non-compliant", "PPSI Approved" "PPSI approved" and
 * "E-Money Token" "E-money token".
 */
function toSentenceCase(label: string): string {
  let seenWord = false;
  return label
    .split(/([\s-]+)/)
    .map((segment) => {
      if (!/\p{L}/u.test(segment)) return segment;
      const isFirst = !seenWord;
      seenWord = true;
      if (isFirst || /^[\p{Lu}\d]{2,}$/u.test(segment)) return segment;
      return segment.toLowerCase();
    })
    .join("");
}

/** Lowercases the leading word of a sentence-case label for use after a prefix ("MiCA non-compliant"). */
function lowerLeadingWord(label: string): string {
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function isGeniusRelevant(genius: GeniusProfile): boolean {
  // A profile reviewed as out-of-scope with nothing to authorize is noise on
  // the detail page; /compliance keeps the exhaustive registry.
  return genius.applicability === "apparent-payment-stablecoin" || genius.authorizationStatus !== "not-applicable";
}

/**
 * `primaryFederalRegulator` is a bounded enum, safe to render as-is. Absent
 * that, `licensingRegulator`/`stateRegulator` are free prose (observed up to
 * ~208 chars) that would overflow the bounded FactGrid cell, so it is sliced
 * at the first parenthetical/clause break; the full string survives as the
 * fact's `title` whenever the slice trims anything.
 */
function buildRegulatorFact(genius: GeniusProfile): RegulatoryFact | null {
  if (genius.primaryFederalRegulator) {
    return {
      key: "regulator",
      label: "Regulator",
      value: genius.primaryFederalRegulator,
      ...(genius.licensingRegulator ? { title: genius.licensingRegulator } : {}),
    };
  }
  const full = genius.licensingRegulator ?? genius.stateRegulator;
  if (!full) return null;
  const cutIndices = [full.indexOf("("), full.indexOf(";"), full.indexOf("/")].filter((index) => index >= 0);
  const cutIndex = cutIndices.length > 0 ? Math.min(...cutIndices) : -1;
  const value = (cutIndex >= 0 ? full.slice(0, cutIndex) : full).trim();
  if (!value) return null;
  return {
    key: "regulator",
    label: "Regulator",
    value,
    ...(value !== full ? { title: full } : {}),
  };
}

/** Report dates retain their own semantics; legacy review dates are never "latest". */
export function formatReserveReportNote(
  report: NonNullable<StablecoinMeta["proofOfReserves"]>["latestReport"],
): string | undefined {
  if (!report) return undefined;
  const dates = [
    report.periodEnd ? `period end ${report.periodEnd}` : undefined,
    report.publishedAt
      ? `${report.publishedAtBasis === "signed-date-standin" ? "signed" : "published"} ${report.publishedAt}`
      : undefined,
  ].filter(Boolean);
  const reference = report.reviewReference;
  const notes = [
    dates.length ? `Latest report: ${dates.join("; ")}` : undefined,
    reference ? `Review reference ${reference.date} (date kind unspecified; as of ${reference.reviewedAt} review)` : undefined,
  ].filter(Boolean);
  return notes.length ? notes.join(" · ") : undefined;
}

type ProofOfReserves = NonNullable<StablecoinMeta["proofOfReserves"]>;
type ProofOfReservesCadence = NonNullable<ProofOfReserves["cadence"]>;

const DISCLOSURE_STATE_LABELS: Record<IssuerDisclosureState, string> = {
  published: "Published",
  gap: "Not found",
  unrecorded: "Not recorded",
};

/**
 * Cadence words for the attestation cell, and whether the cadence meets the
 * monthly attestation GENIUS requires; `none` and `undisclosed` name no cadence.
 */
const ATTESTATION_CADENCES: Partial<Record<ProofOfReservesCadence, { label: string; monthly: boolean }>> = {
  "daily-nav": { label: "Daily NAV", monthly: true },
  "real-time": { label: "Real-time", monthly: true },
  daily: { label: "Daily", monthly: true },
  weekly: { label: "Weekly", monthly: true },
  "semi-monthly": { label: "Semi-monthly", monthly: true },
  monthly: { label: "Monthly", monthly: true },
  quarterly: { label: "Quarterly", monthly: false },
  "semi-annual": { label: "Semi-annual", monthly: false },
  annual: { label: "Annual", monthly: false },
  "ad-hoc": { label: "Ad hoc", monthly: false },
};

function reviewedState(present: boolean | undefined): IssuerDisclosureState {
  if (present == null) return "unrecorded";
  return present ? "published" : "gap";
}

/**
 * The attestation cell. The proof-of-reserves record, the fact behind the
 * hero passport's Attestor entry, is the source of truth whenever it names an
 * attestation: its cadence is the value, and a cadence slower than monthly or
 * a self-attestation is a gap against the monthly independent attestation
 * GENIUS requires. A reviewed `none` tier agrees with "Not found"; without a
 * record, or with an undisclosed attestor, the GENIUS review's finding speaks.
 */
function buildAttestationDisclosure(
  disclosure: IssuerDisclosure,
  genius: GeniusProfile,
  proofOfReserves: ProofOfReserves | undefined,
): IssuerDisclosureRow {
  const tier = proofOfReserves?.attestorTier;
  if (!proofOfReserves || tier === "undisclosed") {
    const state = reviewedState(genius.monthlyAttestationPresent);
    return { ...disclosure, state, value: DISCLOSURE_STATE_LABELS[state] };
  }
  if (tier === "none") return { ...disclosure, state: "gap", value: DISCLOSURE_STATE_LABELS.gap };
  if (tier === "self" || (!tier && proofOfReserves.type === "self-reported")) {
    return {
      ...disclosure,
      state: "gap",
      value: "Self-attested",
      title: "The issuer attests its own reserves. GENIUS requires a monthly attestation by a registered public accounting firm.",
    };
  }

  const attestor = tier ? POR_TIER_STYLES[tier].label : POR_BADGE_STYLES[proofOfReserves.type].label;
  const byline = `Attestor: ${proofOfReserves.provider ? `${proofOfReserves.provider} (${attestor})` : attestor}.`;
  const cadence = proofOfReserves.cadence ? ATTESTATION_CADENCES[proofOfReserves.cadence] : undefined;
  if (cadence) {
    return {
      ...disclosure,
      state: cadence.monthly ? "published" : "gap",
      value: cadence.label,
      title: `${byline} Cadence: ${cadence.label}.${cadence.monthly ? "" : " GENIUS requires a monthly attestation."}`,
    };
  }
  // No cadence on record: the attestation exists; the GENIUS review says whether it is monthly.
  if (genius.monthlyAttestationPresent === false) {
    return {
      ...disclosure,
      state: "gap",
      value: "Not monthly",
      title: `${byline} The GENIUS review found no monthly attestation.`,
    };
  }
  return { ...disclosure, state: "published", value: DISCLOSURE_STATE_LABELS.published, title: byline };
}

/** What the issuer publishes; one row per `ISSUER_DISCLOSURES` entry. */
function buildIssuerDisclosures(
  genius: GeniusProfile,
  proofOfReserves: ProofOfReserves | undefined,
): IssuerDisclosureRow[] {
  const reviewed: Record<Exclude<IssuerDisclosureKey, "attestation">, boolean | undefined> = {
    "redemption-policy": genius.redemptionPolicyPresent,
    "reserve-disclosure": genius.reserveDisclosurePresent,
  };
  return ISSUER_DISCLOSURES.map((disclosure): IssuerDisclosureRow => {
    if (disclosure.key === "attestation") return buildAttestationDisclosure(disclosure, genius, proofOfReserves);
    const state = reviewedState(reviewed[disclosure.key]);
    return {
      ...disclosure,
      state,
      value: DISCLOSURE_STATE_LABELS[state],
      ...(disclosure.key === "reserve-disclosure" && genius.reserveDisclosureUrl
        ? { href: genius.reserveDisclosureUrl }
        : {}),
    };
  });
}

function buildGeniusRegime(genius: GeniusProfile): RegulatoryRegimeView {
  const facts: RegulatoryFact[] = [];
  const regulatorFact = buildRegulatorFact(genius);
  if (regulatorFact) facts.push(regulatorFact);

  return {
    key: "genius",
    regimeLabel: "GENIUS (US)",
    shortLabel: "GENIUS",
    jurisdiction: "US",
    status: {
      label: toSentenceCase(GENIUS_STATUS_SHORT_LABELS[genius.authorizationStatus]),
      toneClass: GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus].cls,
      description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS[genius.authorizationStatus],
    },
    // "Not applicable" alone would read as the status, not the pathway.
    caption: genius.issuerPathway === "not-applicable" ? null : GENIUS_ISSUER_PATHWAY_LABELS[genius.issuerPathway],
    facts,
  };
}

function buildMicaRegime(mica: MicaProfile): RegulatoryRegimeView {
  const style = MICA_STATUS_BADGE_STYLES[mica.status];
  const facts: RegulatoryFact[] = [];
  if (mica.competentAuthority) {
    facts.push({ key: "authority", label: "Authority", value: mica.competentAuthority });
  } else if (mica.authorizationType) {
    facts.push({
      key: "authorization",
      label: "Authorization",
      value: MICA_AUTHORIZATION_TYPE_LABELS[mica.authorizationType],
    });
  }
  return {
    key: "mica",
    regimeLabel: "MiCA (EU)",
    shortLabel: "MiCA",
    jurisdiction: "EU",
    status: {
      label: toSentenceCase(style.label),
      toneClass: style.cls,
      description: MICA_STATUS_DESCRIPTIONS[mica.status],
    },
    caption: mica.tokenType ? toSentenceCase(MICA_TOKEN_TYPE_LABELS[mica.tokenType]) : null,
    facts,
  };
}

function resolveBadge(
  genius: GeniusProfile | null,
  mica: MicaProfile | null,
): { badgeLabel: string; badgeToneClass: string } {
  if (genius && (genius.authorizationStatus === "ppsi-approved" || genius.authorizationStatus === "state-qualified")) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: toSentenceCase(style.label), badgeToneClass: style.cls };
  }
  if (mica?.status === "authorized") {
    const style = MICA_STATUS_BADGE_STYLES.authorized;
    return { badgeLabel: `MiCA ${lowerLeadingWord(toSentenceCase(style.label))}`, badgeToneClass: style.cls };
  }
  if (
    genius &&
    (genius.authorizationStatus === "official-application-pending" ||
      genius.authorizationStatus === "issuer-announced-intent")
  ) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: toSentenceCase(style.label), badgeToneClass: style.cls };
  }
  if (mica && mica.status !== "out-of-scope") {
    const style = MICA_STATUS_BADGE_STYLES[mica.status];
    return { badgeLabel: `MiCA ${lowerLeadingWord(toSentenceCase(style.label))}`, badgeToneClass: style.cls };
  }
  if (genius) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: toSentenceCase(style.label), badgeToneClass: style.cls };
  }
  const style = MICA_STATUS_BADGE_STYLES["out-of-scope"];
  return { badgeLabel: `MiCA ${lowerLeadingWord(toSentenceCase(style.label))}`, badgeToneClass: style.cls };
}

function composeSummary(symbol: string, genius: GeniusProfile | null, mica: MicaProfile | null): string {
  const clauses = [
    genius ? GENIUS_SUMMARY_CLAUSES[genius.authorizationStatus] : null,
    mica ? MICA_SUMMARY_CLAUSES[mica.status] : null,
  ].filter((clause): clause is string => clause !== null);
  return `${symbol} ${clauses.join(" and ")}.`;
}

export function buildRegulatoryStandingView(
  coin: Pick<StablecoinMeta, "symbol" | "genius" | "mica" | "proofOfReserves">,
): RegulatoryStandingView | null {
  const genius = coin.genius && isGeniusRelevant(coin.genius) ? coin.genius : null;
  const mica = coin.mica ?? null;
  if (!genius && !mica) return null;

  const regimes: RegulatoryRegimeView[] = [];
  if (genius) regimes.push(buildGeniusRegime(genius));
  if (mica) regimes.push(buildMicaRegime(mica));

  const sources: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const reference of [...(genius?.references ?? []), ...(mica?.references ?? [])]) {
    if (!reference.url || seen.has(reference.url)) continue;
    seen.add(reference.url);
    sources.push({ label: reference.label, url: reference.url });
  }

  return {
    ...resolveBadge(genius, mica),
    summary: composeSummary(coin.symbol, genius, mica),
    regimes,
    issuerDisclosures: genius ? buildIssuerDisclosures(genius, coin.proofOfReserves) : [],
    // The report dates evidence the reserve disclosure, so they travel only
    // with a GENIUS review that recorded it.
    reportNote:
      genius && genius.reserveDisclosurePresent != null
        ? (formatReserveReportNote(coin.proofOfReserves?.latestReport) ?? null)
        : null,
    notes: genius?.notes ?? null,
    sources,
    reviewedAt: genius?.reviewedAt ?? null,
  };
}
