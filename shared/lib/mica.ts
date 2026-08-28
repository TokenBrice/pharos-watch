import type { MicaAuthorizationType, MicaStatus, MicaTokenType } from "../types/core";
import type { BadgeStyle } from "./classification";

/**
 * MiCA (Regulation (EU) 2023/1114) presentation metadata.
 *
 * MiCA status is a new regulatory dimension distinct from the existing
 * backing / governance / peg / mechanism taxonomy owned by
 * `shared/lib/classification/*`. It lives in its own runtime-neutral module —
 * mirroring how `infrastructure.ts`, `methodology-versions/liquidity-score.ts`, etc. own a
 * single dimension — so the classification facade stays focused on the core
 * coin taxonomy. Tailwind classes are static strings per the repo gotcha.
 */

interface MicaBadgeStyle extends BadgeStyle {
  /** Text-only projection of the pill hue for flat surfaces (hero passport entries) that carry no pill background. */
  textCls?: string;
}

interface MicaStatusDescriptor {
  badge: MicaBadgeStyle;
  description: string;
}

/** Pill style for the EBA-supervised "significant EMT/ART" marker (info-blue: regulatory scope, not a risk state). */
export const MICA_SIGNIFICANT_BADGE_CLS =
  "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";

/** Detail-page / table pill styles per MiCA authorization status. */
const MICA_STATUS_DESCRIPTORS = {
  authorized: {
    badge: {
      label: "Authorized",
      cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
      textCls: "text-green-700 dark:text-green-400",
    },
    description: "Issuer holds an in-effect EMI or credit-institution authorization listed on a competent-authority register.",
  },
  pending: {
    badge: {
      label: "Pending",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
      textCls: "text-amber-700 dark:text-amber-400",
    },
    description: "Authorization application filed with a competent authority; decision outstanding.",
  },
  transitional: {
    badge: {
      label: "Transitional",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
      textCls: "text-amber-700 dark:text-amber-400",
    },
    description: "Offered or traded on EU venues under a member-state CASP grandfathering window; no issuer authorization yet.",
  },
  "non-compliant": {
    badge: {
      label: "Non-Compliant",
      cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
      textCls: "text-red-700 dark:text-red-400",
    },
    description: "In EU scope with no authorization or transitional cover; delisted or restricted on EU venues.",
  },
  "out-of-scope": {
    badge: {
      label: "Out of Scope",
      cls: "bg-muted/40 text-muted-foreground border-border/60",
      textCls: "text-muted-foreground",
    },
    description: "Not offered to the public or admitted to trading in the EU.",
  },
} as const satisfies Record<MicaStatus, MicaStatusDescriptor>;

function projectMicaStatuses<Value>(
  project: (descriptor: MicaStatusDescriptor) => Value,
): Record<MicaStatus, Value> {
  return Object.fromEntries(
    (Object.entries(MICA_STATUS_DESCRIPTORS) as [MicaStatus, MicaStatusDescriptor][])
      .map(([status, descriptor]) => [status, project(descriptor)]),
  ) as Record<MicaStatus, Value>;
}

export const MICA_STATUS_BADGE_STYLES = projectMicaStatuses((descriptor) => descriptor.badge);

/** Full sentence-form descriptions used in tooltips and copy. */
export const MICA_STATUS_DESCRIPTIONS = projectMicaStatuses((descriptor) => descriptor.description);

/** Token-type pill styles (EMT vs ART). */
export const MICA_TOKEN_TYPE_BADGE_STYLES: Record<MicaTokenType, MicaBadgeStyle> = {
  EMT: {
    label: "EMT",
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  },
  ART: {
    label: "ART",
    cls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
  },
};

/** Expanded token-type labels for tooltips and copy. */
export const MICA_TOKEN_TYPE_LABELS: Record<MicaTokenType, string> = {
  EMT: "E-Money Token",
  ART: "Asset-Referenced Token",
};

/** Authorization-route labels. */
export const MICA_AUTHORIZATION_TYPE_LABELS: Record<MicaAuthorizationType, string> = {
  emi: "EMI authorization",
  "credit-institution": "Credit institution",
};
