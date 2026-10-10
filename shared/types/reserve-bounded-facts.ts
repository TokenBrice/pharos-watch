import { z } from "zod";
import rawPolicy from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { StrictIsoDateSchema, Sha256Schema, FractionSchema, UnixSecondsSchema } from "./safety-schema-primitives";
import { V9FactStatusV2Schema } from "./safety-score-v9-fact-primitives";
import { RedemptionBusinessDayTermsSchema } from "./redemption";

const vocabulary = rawPolicy.semantic.backing.reserve.boundedFacts;
export const ReserveBoundedFactKindSchema = z.enum(vocabulary.factKinds as ["contractual-maturity-maximum", "observed-portfolio-maturity", "eligibility-envelope", "currently-liquid-fraction", "maturity-applicability", "stressed-realization-bound", "business-calendar-liquidity"]);
export const ReserveBoundedScopeKindSchema = z.enum(vocabulary.scopeKinds as ["reserve-envelope", "exposure", "sub-instrument"]);
export const ReserveBoundedTermUnitSchema = z.enum(vocabulary.termUnits as ["days", "calendar-months"]);
const text = z.string().trim().min(1);
const fraction = FractionSchema;
const seconds = UnixSecondsSchema;
const term = z.object({ value: z.number().int().nonnegative(), unit: ReserveBoundedTermUnitSchema }).strict();
const ReserveBoundedFactScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reserve-envelope") }).strict(),
  z.object({ kind: z.literal("exposure"), exposureKey: text }).strict(),
  z.object({ kind: z.literal("sub-instrument"), exposureKey: text, instrumentId: text, coveredShare: fraction.nullable(), coverageAsOfSec: seconds }).strict(),
]);
const provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reviewed-research"), reviewedAt: StrictIsoDateSchema, reviewer: text, confidence: z.enum(["high", "medium", "low"]) }).strict(),
  z.object({ kind: z.literal("producer-observation"), observer: text, sourceId: text, sourceGenerationId: text, observedAtSec: seconds, maxAgeSec: z.number().int().positive(), confidence: z.enum(["high", "medium", "low"]) }).strict(),
]);
const base = {
  factKey: text, scope: ReserveBoundedFactScopeSchema, asOfSec: seconds,
  publisher: text, sourceUrls: z.array(z.string().url()).min(1), assertion: text, contentDigest: Sha256Schema,
  provenance,
};
const assetClass = z.enum(Object.keys(rawPolicy.semantic.backing.reserve.assetClassQuality) as ["cash", "bank-deposit", "treasury-bill", "government-security", "repo", "money-market-fund", "stablecoin", "cryptoasset", "hedged-crypto", "private-credit", "public-credit", "tokenized-security", "fund-share", "protocol-position", "commodity-allocated", "other"]);
const grossCoverage = { coveredGrossValue: z.number().finite().nonnegative().nullable(), totalGrossValue: z.number().finite().positive().nullable(), coverageAsOfSec: seconds };
/** Shape-preserving wire contract; runtime refinements and ordering follow below. */
export const ReserveBoundedFactOutputSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("contractual-maturity-maximum"), claimId: text, legallyBinding: z.boolean(), allInScope: z.boolean(), maximumTerm: term }).strict(),
  z.object({ ...base, kind: z.literal("observed-portfolio-maturity"), ...grossCoverage, denomination: text, observedMaximumDays: z.number().int().nonnegative().nullable(), instruments: z.array(z.object({ instrumentId: text, maturityAtSec: seconds.nullable(), grossMarkedValue: z.number().finite().nonnegative(), denomination: text }).strict()) }).strict(),
  z.object({ ...base, kind: z.literal("eligibility-envelope"), legallyBinding: z.boolean(), exhaustive: z.boolean(), allocations: z.array(z.object({ assetClass, minShare: fraction, maxShare: fraction, maximumTerm: term.nullable() }).strict()).min(1) }).strict(),
  z.object({ ...base, kind: z.literal("currently-liquid-fraction"), assetId: text, unit: text, chain: text, currentlyWithdrawable: z.number().finite().nonnegative(), totalHeld: z.number().finite().positive(), snapshotAtSec: seconds, availabilityMeaning: z.literal("currently-withdrawable-native-asset") }).strict(),
  z.object({ ...base, kind: z.literal("maturity-applicability"), claimId: text, conclusion: z.enum(["not-applicable", "open-ended"]), governingInstrument: text, allInScope: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal("stressed-realization-bound"), ...grossCoverage, collateralId: text, scenario: text, haircutBudgetBps: z.number().finite().min(0).max(10000), settlementAsset: text, executionConditions: text, realizationStage: z.enum(["collateral-transfer", "final-cash-settlement"]), elapsedTimeSec: seconds }).strict(),
  z.object({ ...base, kind: z.literal("business-calendar-liquidity"), settlementAsset: text, allInScope: z.boolean(), availableDuring: z.enum(["business-day", "banking-hours"]), businessDayTerms: RedemptionBusinessDayTermsSchema }).strict(),
]);
export const ReserveBoundedFactSchema = ReserveBoundedFactOutputSchema.superRefine((fact, ctx) => {
  const reject = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (fact.scope.kind === "sub-instrument" && fact.scope.coverageAsOfSec !== fact.asOfSec) reject("scope", "Coverage must use the fact snapshot");
  if (fact.provenance.kind === "producer-observation" && fact.provenance.observedAtSec !== fact.asOfSec) reject("provenance", "Observation must use the fact snapshot");
  if (fact.kind === "maturity-applicability" && fact.conclusion === "open-ended" && fact.scope.kind === "reserve-envelope") reject("scope", "Open-ended duration requires an exact exposure or instrument claim");
  if (fact.kind === "currently-liquid-fraction") {
    if (fact.currentlyWithdrawable > fact.totalHeld) reject("currentlyWithdrawable", "Withdrawable amount exceeds total held");
    if (fact.snapshotAtSec !== fact.asOfSec) reject("snapshotAtSec", "Amounts must use the fact snapshot");
  }
  if (fact.kind === "observed-portfolio-maturity" || fact.kind === "stressed-realization-bound") {
    if (fact.coverageAsOfSec !== fact.asOfSec) reject("coverageAsOfSec", "Gross coverage must use the fact snapshot");
    if ((fact.coveredGrossValue === null) !== (fact.totalGrossValue === null)) reject("totalGrossValue", "Gross numerator and denominator must both be present or absent");
    if (fact.coveredGrossValue !== null && fact.totalGrossValue !== null && fact.coveredGrossValue > fact.totalGrossValue) reject("coveredGrossValue", "Gross coverage exceeds denominator");
  }
  if (fact.kind === "observed-portfolio-maturity") {
    if (new Set(fact.instruments.map((row) => row.instrumentId)).size !== fact.instruments.length) reject("instruments", "Duplicate instrument identity");
    if (fact.instruments.some((row) => row.denomination !== fact.denomination)) reject("instruments", "Incompatible gross units");
    const gross = fact.instruments.reduce((sum, row) => sum + row.grossMarkedValue, 0);
    if (fact.coveredGrossValue !== null && Math.abs(gross - fact.coveredGrossValue) > Math.max(1e-8, gross * 1e-10)) reject("coveredGrossValue", "Gross coverage must reconcile to roster");
  }
  if (fact.kind === "eligibility-envelope") {
    if (new Set(fact.allocations.map((row) => row.assetClass)).size !== fact.allocations.length) reject("allocations", "Duplicate eligible class");
    if (fact.allocations.some((row) => row.minShare > row.maxShare) || fact.allocations.reduce((sum, row) => sum + row.minShare, 0) > 1 || fact.allocations.reduce((sum, row) => sum + row.maxShare, 0) < 1) reject("allocations", "Infeasible allocation constraints");
  }
  if (fact.provenance.kind === "producer-observation" && !["currently-liquid-fraction", "observed-portfolio-maturity", "stressed-realization-bound"].includes(fact.kind)) reject("provenance", "Governing constraints require reviewed research");
}).transform((fact) => {
  const sourceUrls = [...new Set(fact.sourceUrls)].sort();
  if (fact.kind === "eligibility-envelope") return { ...fact, sourceUrls, allocations: [...fact.allocations].sort((a, b) => a.assetClass.localeCompare(b.assetClass)) };
  if (fact.kind === "observed-portfolio-maturity") return { ...fact, sourceUrls, instruments: [...fact.instruments].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)) };
  return { ...fact, sourceUrls };
});
export type ReserveBoundedFact = z.output<typeof ReserveBoundedFactSchema>;
export const V9ReserveBoundedFactSchema = z.object({ fact: ReserveBoundedFactSchema, status: V9FactStatusV2Schema, sourceGenerationId: text, freshnessMaxAgeSec: z.number().int().positive(), rejectionReason: text.nullable() }).strict().superRefine((value, ctx) => {
  if (value.status.observationState === "known" && (value.status.evidenceRefIds.length === 0 || value.rejectionReason !== null)) ctx.addIssue({ code: "custom", message: "Admitted bounds require evidence and no rejection" });
  if (value.status.observationState !== "known" && value.rejectionReason === null) ctx.addIssue({ code: "custom", message: "Unavailable bounds require a reason" });
});
export type V9ReserveBoundedFact = z.output<typeof V9ReserveBoundedFactSchema>;
