import type {
  GeniusApplicability,
  GeniusAuthorizationStatus,
  GeniusIssuerPathway,
} from "../types/core";

interface GeniusBadgeStyle {
  label: string;
  cls: string;
}

export const GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES: Record<GeniusAuthorizationStatus, GeniusBadgeStyle> = {
  "ppsi-approved": {
    label: "PPSI Approved",
    cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
  "state-qualified": {
    label: "State Qualified",
    cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
  "official-application-pending": {
    label: "Official Pending",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  },
  "issuer-announced-intent": {
    label: "Issuer Intent",
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  },
  "no-public-authorization-found": {
    label: "No Public Auth Found",
    cls: "bg-muted/40 text-muted-foreground border-border/60",
  },
  "not-applicable": {
    label: "Not Applicable",
    cls: "bg-muted/40 text-muted-foreground border-border/60",
  },
  unknown: {
    label: "Unknown",
    cls: "bg-muted/40 text-muted-foreground border-border/60",
  },
};

export const GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS: Record<GeniusAuthorizationStatus, string> = {
  "ppsi-approved": "Official source identifies a domestic permitted payment stablecoin issuer approval for this token or issuer pathway.",
  "state-qualified": "Official source identifies a state-qualified payment stablecoin issuer pathway.",
  "official-application-pending": "Public regulator source shows an application or registration is filed and pending.",
  "issuer-announced-intent": "Issuer or partner materials signal a GENIUS-era issuance path, but no token-specific official approval was found.",
  "no-public-authorization-found": "A dated negative-evidence review found no qualifying public approval, application, or registration source.",
  "not-applicable": "The reviewed asset is outside the tracked GENIUS payment-stablecoin authorization posture.",
  unknown: "The public posture has not been resolved from available sources.",
};

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
