import type {
  GeniusApplicability,
  GeniusAuthorizationStatus,
  GeniusDaspOfferSaleStatus,
  GeniusEnforcementStatus,
  GeniusForeignExceptionStatus,
  GeniusIssuerPathway,
} from "../types/core";
import type { BadgeStyle } from "./classification";

interface GeniusAuthorizationStatusDescriptor {
  badge: BadgeStyle;
  shortLabel: string;
  textCls: string | undefined;
  description: string;
}

const GENIUS_AUTHORIZATION_STATUS_DESCRIPTORS = {
  "ppsi-approved": {
    badge: {
      label: "PPSI Approved",
      cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    },
    shortLabel: "PPSI Approved",
    textCls: "text-emerald-700 dark:text-emerald-400",
    description: "Official source identifies a domestic permitted payment stablecoin issuer approval for this token or issuer pathway.",
  },
  "state-qualified": {
    badge: {
      label: "State Qualified",
      cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    },
    shortLabel: "State Qualified",
    textCls: "text-emerald-700 dark:text-emerald-400",
    description: "Official source identifies a state-qualified payment stablecoin issuer pathway.",
  },
  "official-application-pending": {
    badge: {
      label: "Official Pending",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    },
    shortLabel: "Filing Pending",
    textCls: undefined,
    description: "Public regulator source shows an application or registration is filed and pending.",
  },
  "issuer-announced-intent": {
    badge: {
      label: "Issuer Intent",
      cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
    },
    shortLabel: "Issuer Intent",
    textCls: undefined,
    description: "Issuer or partner materials signal a GENIUS-era issuance path, but no token-specific official approval was found.",
  },
  "no-public-authorization-found": {
    badge: { label: "No Public Auth Found", cls: "bg-muted/40 text-muted-foreground border-border/60" },
    shortLabel: "None Found",
    textCls: "text-muted-foreground",
    description: "A dated negative-evidence review found no qualifying public approval, application, or registration source.",
  },
  "not-applicable": {
    badge: { label: "Not Applicable", cls: "bg-muted/40 text-muted-foreground border-border/60" },
    shortLabel: "Not Applicable",
    textCls: "text-muted-foreground",
    description: "The reviewed asset is outside the tracked GENIUS payment-stablecoin authorization posture.",
  },
  unknown: {
    badge: { label: "Unknown", cls: "bg-muted/40 text-muted-foreground border-border/60" },
    shortLabel: "Unknown",
    textCls: "text-muted-foreground",
    description: "The public posture has not been resolved from available sources.",
  },
} as const satisfies Record<GeniusAuthorizationStatus, GeniusAuthorizationStatusDescriptor>;

function projectAuthorizationStatuses<Value>(
  project: (descriptor: GeniusAuthorizationStatusDescriptor) => Value,
): Record<GeniusAuthorizationStatus, Value> {
  return Object.fromEntries(
    (Object.entries(GENIUS_AUTHORIZATION_STATUS_DESCRIPTORS) as [
      GeniusAuthorizationStatus,
      GeniusAuthorizationStatusDescriptor,
    ][]).map(([status, descriptor]) => [status, project(descriptor)]),
  ) as Record<GeniusAuthorizationStatus, Value>;
}

export const GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES = projectAuthorizationStatuses(
  (descriptor) => descriptor.badge,
);

/**
 * Authored-short authorization-status labels for dense surfaces (hero
 * passport strip). The regime is still in its rulemaking phase
 * (`GENIUS_REGIME_STATE` in `shared/lib/compliance-regime-state.ts`), so
 * every label describes a *pathway* status — never a present-day federal
 * license.
 */
export const GENIUS_STATUS_SHORT_LABELS = projectAuthorizationStatuses((descriptor) => descriptor.shortLabel);

/**
 * Text-only tones for flat surfaces that carry no pill background. Approved
 * pathways read emerald, in-flight pathways keep the default foreground
 * (`undefined`), and absent/inapplicable statuses are muted. Tailwind classes
 * are static strings per the repo gotcha.
 */
export const GENIUS_STATUS_TEXT_CLS = projectAuthorizationStatuses((descriptor) => descriptor.textCls);

export const GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS = projectAuthorizationStatuses(
  (descriptor) => descriptor.description,
);

export const GENIUS_APPLICABILITY_LABELS: Record<GeniusApplicability, string> = {
  "apparent-payment-stablecoin": "Apparent payment stablecoin",
  "excluded-deposit": "Excluded deposit",
  "excluded-security": "Excluded security",
  "excluded-national-currency": "Excluded national currency",
  "non-payment-token": "Non-payment token",
  unclear: "Unclear",
};

export const GENIUS_ISSUER_PATHWAY_LABELS: Record<GeniusIssuerPathway, string> = {
  "idi-subsidiary": "IDI subsidiary",
  "federal-qualified-nonbank": "Federal qualified issuer",
  "state-qualified": "State qualified issuer",
  "foreign-registered": "Foreign registered issuer",
  unknown: "Pathway unresolved",
  "not-applicable": "Not applicable",
};

export const GENIUS_FOREIGN_EXCEPTION_STATUS_LABELS: Record<GeniusForeignExceptionStatus, string> = {
  "registered-exception": "Registered exception",
  "comparability-determined": "Comparable regime determined",
  "registration-pending": "Registration pending",
  "not-qualified": "Not qualified",
  "not-applicable": "Not applicable",
  unknown: "Unknown",
};

export const GENIUS_ENFORCEMENT_STATUS_LABELS: Record<GeniusEnforcementStatus, string> = {
  "no-public-action-found": "No public action found",
  "warning-or-notice": "Warning or notice",
  "prohibited-or-revoked": "Prohibited or revoked",
  unknown: "Unknown",
};

export const GENIUS_DASP_OFFER_SALE_STATUS_LABELS: Record<GeniusDaspOfferSaleStatus, string> = {
  "not-yet-restricted": "Not yet restricted",
  restricted: "Restricted",
  "foreign-lawful-order-condition-active": "Foreign lawful order condition active",
  "not-applicable": "Not applicable",
  unknown: "Unknown",
};
