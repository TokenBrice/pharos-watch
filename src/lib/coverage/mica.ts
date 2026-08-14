import { MICA_STATUS_DESCRIPTIONS } from "@shared/lib/mica";
import type { MicaProfile } from "@shared/types";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createBreakdownCounter,
  createPresetStatus,
  defineCoverageFeature,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const MICA_STATUS_PRESETS = {
  authorized: {
    kind: "authorized",
    label: "Authorized",
    tone: "emerald",
    available: true,
    sortRank: 5,
    detail: MICA_STATUS_DESCRIPTIONS.authorized,
  },
  pending: {
    kind: "pending",
    label: "Pending",
    tone: "amber",
    available: true,
    sortRank: 4,
    detail: MICA_STATUS_DESCRIPTIONS.pending,
  },
  transitional: {
    kind: "transitional",
    label: "Transitional",
    tone: "amber",
    available: true,
    sortRank: 3,
    detail: MICA_STATUS_DESCRIPTIONS.transitional,
  },
  "non-compliant": {
    kind: "non-compliant",
    label: "Non-Comp.",
    spokenLabel: "Non-compliant",
    tone: "rose",
    available: true,
    sortRank: 2,
    detail: MICA_STATUS_DESCRIPTIONS["non-compliant"],
  },
  "out-of-scope": {
    kind: "out-of-scope",
    label: "Out Scope",
    spokenLabel: "Out of scope",
    tone: "slate",
    available: true,
    sortRank: 1,
    detail: MICA_STATUS_DESCRIPTIONS["out-of-scope"],
  },
  unassessed: {
    kind: "unassessed",
    label: "Not Assessed",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail:
      "No structured MiCA assessment is available for this active stablecoin. Missing metadata is not an authorization, non-compliance, or out-of-scope finding.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveMica(profile?: Pick<MicaProfile, "status" | "tokenType" | "competentAuthority"> | null): CoverageStatus {
  if (!profile) {
    return createPresetStatus(MICA_STATUS_PRESETS.unassessed);
  }

  const status = createPresetStatus(MICA_STATUS_PRESETS[profile.status]);
  const context = [
    profile.tokenType ? `Token type: ${profile.tokenType}.` : null,
    profile.competentAuthority ? `Authority: ${profile.competentAuthority}.` : null,
  ].filter(Boolean);

  return context.length > 0 ? { ...status, detail: `${status.detail} ${context.join(" ")}` } : status;
}

function formatMica(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("authorized", "authorized", get("authorized")),
    breakdownItem("pending", "pending", get("pending")),
    breakdownItem("transitional", "transitional", get("transitional")),
    breakdownItem("non-compliant", "non-compliant", get("non-compliant")),
    breakdownItem("out-of-scope", "out-of-scope", get("out-of-scope")),
    breakdownItem("unassessed", "not assessed", get("unassessed")),
  ];
}

const MICA_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Authorized",
    description: MICA_STATUS_DESCRIPTIONS.authorized,
    kinds: ["authorized"],
  },
  {
    term: "Pending",
    description: MICA_STATUS_DESCRIPTIONS.pending,
    kinds: ["pending"],
  },
  {
    term: "Transitional",
    description: MICA_STATUS_DESCRIPTIONS.transitional,
    kinds: ["transitional"],
  },
  {
    term: "Non-Comp.",
    description: MICA_STATUS_DESCRIPTIONS["non-compliant"],
    kinds: ["non-compliant"],
  },
  {
    term: "Out Scope",
    description: MICA_STATUS_DESCRIPTIONS["out-of-scope"],
    kinds: ["out-of-scope"],
  },
  {
    term: "Not Assessed",
    description:
      "No structured MiCA assessment is available for this active stablecoin. Missing metadata is not an authorization, non-compliance, or out-of-scope finding.",
    kinds: ["unassessed"],
  },
];

export const coverageFeature = defineCoverageFeature({
  statusKinds: statusKindsFromPresets(MICA_STATUS_PRESETS),
  legendItems: MICA_LEGEND,
  resolve: resolveMica,
  formatBreakdown: formatMica,
});
