import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { FxReferenceObservationSchema } from "@shared/types/fx-reference";
import type { ReferenceAdmission } from "@shared/types/reference-admission";
import { z } from "zod";
import type { SafetyScoreV9CompilerInput } from "./native-input";

export const EUR_VAULT_PAYOUT_REFERENCE_PREFIX = "eur-vault-payout:";

export function isSameReferenceSession(pegCurrency: string, from: number, to: number): boolean {
  const market = getReferenceMarket(pegCurrency);
  if (!market || from <= 0 || from > to || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  const original = getReferenceSessionState(market, from);
  const current = getReferenceSessionState(market, to);
  return original.open === current.open && original.sessionOpenedAtSec === current.sessionOpenedAtSec &&
    original.closureStartSec === current.closureStartSec;
}

type PegReferenceEvidence = { referenceAdmission?: ReferenceAdmission; admittedDeviationBps?: number | null };

function carriesReferenceEvidence(row: PegReferenceEvidence | undefined): boolean {
  return row?.referenceAdmission !== undefined || row?.admittedDeviationBps !== undefined;
}

/** A history-only sidecar predates reference admission. An explicitly empty map opts in. */
export function getPegReferenceEvidence(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>, assetId: string,
): PegReferenceEvidence | undefined {
  const sidecar = fixedInput.pegEvidenceById;
  const entry = sidecar?.[assetId];
  if (carriesReferenceEvidence(entry)) return entry;
  const peg = fixedInput.pegDataById[assetId];
  if (carriesReferenceEvidence(peg)) return peg;
  if (sidecar !== undefined) {
    const entries = Object.values(sidecar);
    if (entries.length === 0 || entries.some(carriesReferenceEvidence)) return {};
  }
  // The same packet can be carried inline by the peg producer on rollback.
  for (const id in fixedInput.pegDataById) {
    if (carriesReferenceEvidence(fixedInput.pegDataById[id])) return {};
  }
  return undefined;
}

export function hasCurrentPegAdmission(
  pegCurrency: string, admission: ReferenceAdmission | undefined, quoteObservedAtSec: number | null | undefined,
  referenceKind: string | undefined, clockSec: number,
): boolean {
  return admission?.status === "admitted" && admission.reason !== "daily-fixing-above-band" &&
    admission.quoteObservedAtSec === quoteObservedAtSec && admission.kind === referenceKind &&
    clockSec - admission.referenceObservedAtSec <= admission.budgetSec &&
    isSameReferenceSession(pegCurrency, admission.decisionAtSec, clockSec);
}

const DirectMetalReferenceSchema = z.strictObject({
  observation: FxReferenceObservationSchema,
  generation: z.string().trim().min(1),
  preCloseUsdPerUnit: z.number().finite().positive().nullish(),
  firstInSessionObservedAtSec: z.number().int().positive().nullish(),
});
export const DirectMetalReferencesSchema = z.strictObject({
  peggedGOLD: DirectMetalReferenceSchema.optional(),
  peggedSILVER: DirectMetalReferenceSchema.optional(),
});
type DirectMetalReferences = z.output<typeof DirectMetalReferencesSchema>;

export function parseDirectMetalReferences(value: unknown): DirectMetalReferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const references: DirectMetalReferences = {};
  for (const peg of ["peggedGOLD", "peggedSILVER"] as const) {
    const parsed = DirectMetalReferenceSchema.safeParse((value as Record<string, unknown>)[peg]);
    if (parsed.success && parsed.data.observation.pegKey === peg) references[peg] = parsed.data;
  }
  return references;
}

export function admitDirectMetalBenchmark(
  references: DirectMetalReferences | undefined, metal: "XAU" | "XAG", clockSec: number,
) {
  const pegKey = metal === "XAU" ? "peggedGOLD" : "peggedSILVER";
  const candidate = references?.[pegKey];
  if (!candidate) return null;
  const { observation, generation, preCloseUsdPerUnit, firstInSessionObservedAtSec } = candidate;
  const { source, cadence, observedAtSec } = observation;
  if (observation.pegKey !== pegKey || cadence !== "intraday" ||
      (source !== "gold-api.com" && source !== "chainlink") || observedAtSec <= 0 ||
      (observation.publishedAtSec ?? observedAtSec) > clockSec) return null;
  // Check benchmark repricing at its sample clock. A token quote cannot
  // establish or suppress eligibility of the independent bullion mark.
  const admission = evaluateReferenceAdmission({
    kind: "fallback", observation: { ...observation, publishedAtSec: undefined }, generation,
    quoteObservedAtSec: observedAtSec, decisionAtSec: observedAtSec, rawDeviationBps: null,
    preCloseUsdPerUnit, firstInSessionObservedAtSec,
  });
  if (admission.status !== "admitted" || admission.reason !== "live-reference") return null;
  return { usdPerTroyOunce: observation.usdPerUnit, observedAtSec, source, generation };
}
