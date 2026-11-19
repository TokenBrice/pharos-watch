import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { FxMedianContributorSchema, FxReferenceObservationSchema, FxRepricingSchema, type FxReferenceObservation } from "@shared/types/fx-reference";
import { z } from "zod";
import { sanitizeRecordValues } from "./normalizers";

const sessionEvidenceSchema = FxRepricingSchema.omit({ source: true }).required();

const sourceSampleSchema = z.object({
  observation: FxReferenceObservationSchema,
  evidence: sessionEvidenceSchema,
});

export type FxReferenceSessionEvidence = z.output<typeof sessionEvidenceSchema>;
export type FxReferenceSourceSamples = Record<string, z.output<typeof sourceSampleSchema>>;

const fxMedianContributorSchema = FxMedianContributorSchema.required({ assetId: true });
export type FxMedianContributor = z.output<typeof fxMedianContributorSchema>;
export type FxMedianContributorsByPeg = Record<string, FxMedianContributor[]>;

export function parseFxMedianContributors(input: unknown): FxMedianContributorsByPeg {
  const schema = z.array(fxMedianContributorSchema).nonempty();
  return sanitizeRecordValues(input, (value) => schema.safeParse(value).data);
}

const fxBaselineSchema = z.object({
  usdPerUnit: z.number().finite().positive(),
  observedAtSec: z.number().int().positive().nullable(),
});
export type FxBaseline = z.output<typeof fxBaselineSchema>;

export function parseFxBaselines(input: unknown): Record<string, FxBaseline> {
  return sanitizeRecordValues(input, (value) => fxBaselineSchema.safeParse(value).data);
}

const fxRegimeChangeSchema = z.object({
  previous: fxBaselineSchema,
  replacement: FxReferenceObservationSchema,
});

export type FxRegimeChanges = Record<string, z.output<typeof fxRegimeChangeSchema>>;

export function parseFxRegimeChanges(input: unknown): FxRegimeChanges {
  return sanitizeRecordValues(input, (value, pegKey) => {
    const parsed = fxRegimeChangeSchema.safeParse(value);
    return parsed.success && parsed.data.replacement.pegKey === pegKey
      && (parsed.data.previous.observedAtSec == null || parsed.data.previous.observedAtSec < parsed.data.replacement.observedAtSec)
      ? parsed.data : undefined;
  });
}

export function fxSourceSampleKey(observation: FxReferenceObservation): string {
  return `${observation.pegKey}:${observation.source}`;
}

export function parseFxSourceSamples(input: unknown): FxReferenceSourceSamples {
  return sanitizeRecordValues(input, (value, key) => {
    const parsed = sourceSampleSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { observation, evidence } = parsed.data;
    const market = getReferenceMarket(getPegTaxonomyByType(observation.pegKey)?.currency);
    const session = market && Number.isFinite(new Date(observation.observedAtSec * 1000).getTime())
      && getReferenceSessionState(market, observation.observedAtSec);
    return key === fxSourceSampleKey(observation)
      && session && session.open && session.sessionOpenedAtSec === evidence.sessionOpenedAtSec
      && evidence.sessionOpenedAtSec <= evidence.firstInSessionObservedAtSec
      && evidence.firstInSessionObservedAtSec <= observation.observedAtSec
      ? parsed.data : undefined;
  });
}

export function recordFxSourceSample(
  samples: FxReferenceSourceSamples,
  observation: FxReferenceObservation,
  isFreshAt: (observation: FxReferenceObservation, atSec: number) => boolean,
): void {
  const market = getReferenceMarket(getPegTaxonomyByType(observation.pegKey)?.currency);
  if (!market) return;
  const session = getReferenceSessionState(market, observation.observedAtSec);
  if (!session.open) return;

  const key = fxSourceSampleKey(observation);
  const previous = samples[key];
  if (previous && previous.observation.observedAtSec > observation.observedAtSec) return;
  if (previous?.evidence.sessionOpenedAtSec === session.sessionOpenedAtSec) {
    samples[key] = { observation, evidence: previous.evidence };
    return;
  }
  const closure = getReferenceSessionState(market, session.sessionOpenedAtSec - 1);
  const prior = !closure.open ? getReferenceSessionState(market, closure.closureStartSec - 1) : null;
  samples[key] = {
    observation,
    evidence: {
      sessionOpenedAtSec: session.sessionOpenedAtSec,
      firstInSessionObservedAtSec: observation.observedAtSec,
      preCloseUsdPerUnit: prior?.open && previous?.evidence.sessionOpenedAtSec === prior.sessionOpenedAtSec
        && !closure.open && isFreshAt(previous.observation, closure.closureStartSec)
        ? previous.observation.usdPerUnit : null,
    },
  };
}
