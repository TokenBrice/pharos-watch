import { z } from "zod";
import { LiveReserveSnapshotProvenanceShapeSchema, ReserveObservationEnvelopeSchema } from "../../types/safety-score-v9-reserve-scope";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

/** Preserve malformed producer evidence as a digest-bound failure before fixed-input admission. */
export const LiveReserveSnapshotProvenanceSchema = z.preprocess((value) => {
  if (value == null || typeof value !== "object" || !("reserveObservation" in value) || value.reserveObservation === undefined) return value;
  if (ReserveObservationEnvelopeSchema.safeParse(value.reserveObservation).success) return value;
  return { ...value, reserveObservation: undefined, reserveObservationFailure: {
    code: "producer-failed", reason: "malformed-reserve-observation",
    sourceSha256: sha256Hex(stableJsonStringifyV1(value.reserveObservation)),
  } };
}, LiveReserveSnapshotProvenanceShapeSchema);
