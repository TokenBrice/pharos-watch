// src/lib/regulatory-standing.ts
import type {
  GeniusAuthorizationStatus,
  GeniusProfile,
  MicaProfile,
  MicaStatus,
  StablecoinMeta,
} from "@shared/types";
import {
  GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES,
  GENIUS_ISSUER_PATHWAY_LABELS,
  GENIUS_STATUS_SHORT_LABELS,
  GENIUS_STATUS_TEXT_CLS,
} from "@shared/lib/genius";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_STATUS_BADGE_STYLES,
  MICA_TOKEN_TYPE_LABELS,
} from "@shared/lib/mica";

/**
 * On-page view of the coin's regulatory standing across the GENIUS (US) and
 * MiCA (EU) regimes: per-regime status facts plus the GENIUS obligations
 * checklist (monthly attestation / redemption policy / reserve disclosure)
 * that today only exists off-page on /compliance. Pure derivation from the
 * client coin — no fetch, no server-only imports.
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

export interface RegulatoryChecklistRow {
  key: string;
  label: string;
  present: boolean;
  href?: string;
  note?: string;
}

export interface RegulatoryRegimeView {
  key: "genius" | "mica";
  regimeLabel: string;
  facts: RegulatoryFact[];
  checklist: RegulatoryChecklistRow[];
}

export interface RegulatoryStandingView {
  badgeLabel: string;
  badgeToneClass: string;
  summary: string;
  regimes: RegulatoryRegimeView[];
  sources: { label: string; url: string }[];
  reviewedAt: string | null;
}

const GENIUS_SUMMARY_CLAUSES: Record<GeniusAuthorizationStatus, string> = {
  "ppsi-approved": "is federally approved as a permitted payment stablecoin issuer under the GENIUS Act",
  "state-qualified": "is state-qualified under the GENIUS Act",
  "official-application-pending": "has a GENIUS authorization filing pending",
  "issuer-announced-intent": "has announced intent to seek GENIUS authorization",
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

const MUTED_BADGE_TONE = "border-border/60 bg-muted/30 text-muted-foreground";

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
    return { key: "regulator", label: "Regulator", value: genius.primaryFederalRegulator };
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

function buildGeniusRegime(genius: GeniusProfile): RegulatoryRegimeView {
  const facts: RegulatoryFact[] = [
    {
      key: "status",
      label: "Status",
      value: GENIUS_STATUS_SHORT_LABELS[genius.authorizationStatus],
      ...(GENIUS_STATUS_TEXT_CLS[genius.authorizationStatus]
        ? { valueClassName: GENIUS_STATUS_TEXT_CLS[genius.authorizationStatus] }
        : {}),
    },
    { key: "pathway", label: "Pathway", value: GENIUS_ISSUER_PATHWAY_LABELS[genius.issuerPathway] },
  ];
  const regulatorFact = buildRegulatorFact(genius);
  if (regulatorFact) facts.push(regulatorFact);

  const checklist: RegulatoryChecklistRow[] = [];
  if (genius.monthlyAttestationPresent != null) {
    checklist.push({
      key: "attestation",
      label: "Monthly attestation",
      present: genius.monthlyAttestationPresent,
    });
  }
  if (genius.redemptionPolicyPresent != null) {
    checklist.push({
      key: "redemption-policy",
      label: "Redemption policy",
      present: genius.redemptionPolicyPresent,
    });
  }
  if (genius.reserveDisclosurePresent != null) {
    checklist.push({
      key: "reserve-disclosure",
      label: "Reserve disclosure",
      present: genius.reserveDisclosurePresent,
      ...(genius.reserveDisclosureUrl ? { href: genius.reserveDisclosureUrl } : {}),
      ...(genius.latestReportDate ? { note: `latest ${genius.latestReportDate}` } : {}),
    });
  }

  return { key: "genius", regimeLabel: "GENIUS (US)", facts, checklist };
}

function buildMicaRegime(mica: MicaProfile): RegulatoryRegimeView {
  const style = MICA_STATUS_BADGE_STYLES[mica.status];
  const facts: RegulatoryFact[] = [
    { key: "status", label: "Status", value: style.label, valueClassName: style.textCls },
  ];
  if (mica.tokenType) {
    facts.push({ key: "token-type", label: "Token type", value: MICA_TOKEN_TYPE_LABELS[mica.tokenType] });
  }
  if (mica.competentAuthority) {
    facts.push({ key: "authority", label: "Authority", value: mica.competentAuthority });
  } else if (mica.authorizationType) {
    facts.push({
      key: "authorization",
      label: "Authorization",
      value: MICA_AUTHORIZATION_TYPE_LABELS[mica.authorizationType],
    });
  }
  return { key: "mica", regimeLabel: "MiCA (EU)", facts, checklist: [] };
}

function resolveBadge(
  genius: GeniusProfile | null,
  mica: MicaProfile | null,
): { badgeLabel: string; badgeToneClass: string } {
  if (genius && (genius.authorizationStatus === "ppsi-approved" || genius.authorizationStatus === "state-qualified")) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: style.label, badgeToneClass: style.cls };
  }
  if (mica?.status === "authorized") {
    return { badgeLabel: "MiCA Authorized", badgeToneClass: MICA_STATUS_BADGE_STYLES.authorized.cls };
  }
  if (
    genius &&
    (genius.authorizationStatus === "official-application-pending" ||
      genius.authorizationStatus === "issuer-announced-intent")
  ) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: style.label, badgeToneClass: style.cls };
  }
  if (mica && mica.status !== "out-of-scope") {
    const style = MICA_STATUS_BADGE_STYLES[mica.status];
    return { badgeLabel: `MiCA ${style.label}`, badgeToneClass: style.cls };
  }
  if (genius) {
    const style = GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[genius.authorizationStatus];
    return { badgeLabel: style.label, badgeToneClass: style.cls };
  }
  return { badgeLabel: "Out of Scope", badgeToneClass: MUTED_BADGE_TONE };
}

function composeSummary(symbol: string, genius: GeniusProfile | null, mica: MicaProfile | null): string {
  const clauses = [
    genius ? GENIUS_SUMMARY_CLAUSES[genius.authorizationStatus] : null,
    mica ? MICA_SUMMARY_CLAUSES[mica.status] : null,
  ].filter((clause): clause is string => clause !== null);
  return `${symbol} ${clauses.join(" and ")}.`;
}

export function buildRegulatoryStandingView(
  coin: Pick<StablecoinMeta, "symbol" | "genius" | "mica">,
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
    sources,
    reviewedAt: genius?.reviewedAt ?? null,
  };
}
