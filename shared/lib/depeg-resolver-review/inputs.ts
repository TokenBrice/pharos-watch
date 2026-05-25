import type { DdrrActualEvent, DdrrAssessment } from "../../types/depeg-resolver-review";

export type DdrrAssessmentInput = DdrrAssessment;
export type DdrrActualEventInput = DdrrActualEvent;

export interface DdrrReviewInput {
  assessment: DdrrAssessmentInput;
  actualEvent: DdrrActualEventInput | null;
  nowSec: number;
}

export type DdrrActualEventLookup =
  | ReadonlyMap<number, DdrrActualEventInput | null | undefined>
  | Record<number, DdrrActualEventInput | null | undefined>;

function hasMapLookup(
  lookup: DdrrActualEventLookup,
): lookup is ReadonlyMap<number, DdrrActualEventInput | null | undefined> {
  return typeof (lookup as ReadonlyMap<number, DdrrActualEventInput | null | undefined>).get === "function";
}

export interface DdrrReviewBatchInput {
  assessments: DdrrAssessmentInput[];
  actualEventsById: DdrrActualEventLookup;
  nowSec: number;
}

export function lookupActualEvent(
  lookup: DdrrActualEventLookup,
  eventId: number,
): DdrrActualEventInput | null {
  if (hasMapLookup(lookup)) {
    return lookup.get(eventId) ?? null;
  }
  return lookup[eventId] ?? null;
}
