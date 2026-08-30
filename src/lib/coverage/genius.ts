import {
  GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS,
  GENIUS_STATUS_SHORT_LABELS,
} from "@shared/lib/genius";
import type { GeniusClientProfile } from "@shared/types/stablecoin-client-meta";
import type { CoverageStatus } from "@/lib/coverage-types";
import {
  createPresetStatus,
  definePresetCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const GENIUS_STATUS_PRESETS = {
  "ppsi-approved": {
    kind: "ppsi-approved",
    label: GENIUS_STATUS_SHORT_LABELS["ppsi-approved"],
    tone: "emerald",
    available: true,
    sortRank: 7,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["ppsi-approved"],
  },
  "state-qualified": {
    kind: "state-qualified",
    label: GENIUS_STATUS_SHORT_LABELS["state-qualified"],
    tone: "emerald",
    available: true,
    sortRank: 6,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["state-qualified"],
  },
  "official-application-pending": {
    kind: "official-application-pending",
    label: GENIUS_STATUS_SHORT_LABELS["official-application-pending"],
    tone: "amber",
    available: true,
    sortRank: 5,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["official-application-pending"],
  },
  "issuer-announced-intent": {
    kind: "issuer-announced-intent",
    label: GENIUS_STATUS_SHORT_LABELS["issuer-announced-intent"],
    tone: "sky",
    available: true,
    sortRank: 4,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["issuer-announced-intent"],
  },
  "no-public-authorization-found": {
    kind: "no-public-authorization-found",
    label: GENIUS_STATUS_SHORT_LABELS["no-public-authorization-found"],
    tone: "slate",
    available: true,
    sortRank: 3,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["no-public-authorization-found"],
  },
  "not-applicable": {
    kind: "not-applicable",
    label: GENIUS_STATUS_SHORT_LABELS["not-applicable"],
    tone: "slate",
    available: true,
    sortRank: 2,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["not-applicable"],
  },
  unknown: {
    kind: "unknown",
    label: GENIUS_STATUS_SHORT_LABELS.unknown,
    tone: "amber",
    available: true,
    sortRank: 1,
    detail: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS.unknown,
  },
  unassessed: {
    kind: "unassessed",
    label: "Not Assessed",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail:
      "No structured GENIUS Act assessment is available for this active stablecoin. Missing metadata is not an authorization, no-authorization, or not-applicable finding.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveGenius(profile?: GeniusClientProfile | null): CoverageStatus {
  if (!profile) {
    return createPresetStatus(GENIUS_STATUS_PRESETS.unassessed);
  }

  return createPresetStatus(GENIUS_STATUS_PRESETS[profile.authorizationStatus]);
}

const GENIUS_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "PPSI Approved",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["ppsi-approved"],
    kinds: ["ppsi-approved"],
  },
  {
    term: "State Qualified",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["state-qualified"],
    kinds: ["state-qualified"],
  },
  {
    term: "Filing Pending",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["official-application-pending"],
    kinds: ["official-application-pending"],
  },
  {
    term: "Issuer Intent",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["issuer-announced-intent"],
    kinds: ["issuer-announced-intent"],
  },
  {
    term: "None Found",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["no-public-authorization-found"],
    kinds: ["no-public-authorization-found"],
  },
  {
    term: "Not Applicable",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS["not-applicable"],
    kinds: ["not-applicable"],
  },
  {
    term: "Unknown",
    description: GENIUS_AUTHORIZATION_STATUS_DESCRIPTIONS.unknown,
    kinds: ["unknown"],
  },
  {
    term: "Not Assessed",
    description:
      "No structured GENIUS Act assessment is available for this active stablecoin. Missing metadata is not an authorization, no-authorization, or not-applicable finding.",
    kinds: ["unassessed"],
  },
];

export const coverageFeature = definePresetCoverageFeature({
  presets: GENIUS_STATUS_PRESETS,
  breakdown: [
    { key: "ppsi-approved", label: "ppsi approved" },
    { key: "state-qualified", label: "state qualified" },
    { key: "official-application-pending", label: "filing pending" },
    { key: "issuer-announced-intent", label: "issuer intent" },
    { key: "no-public-authorization-found", label: "none found" },
    { key: "not-applicable", label: "not applicable" },
    { key: "unknown", label: "unknown" },
    { key: "unassessed", label: "not assessed" },
  ],
  legendItems: GENIUS_LEGEND,
  resolve: resolveGenius,
});
