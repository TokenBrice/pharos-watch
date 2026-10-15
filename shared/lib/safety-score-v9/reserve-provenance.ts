import { z } from "zod";
import { LiveReserveSnapshotProvenanceShapeSchema, ReserveObservationEnvelopeSchema } from "../../types/safety-score-v9-reserve-scope";
import { LenderBookObservationSchema } from "../../types/safety-score-v9-lender-book";
import { canonicalizeLenderBookObservation } from "./lender-book-registry";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

/** Preserve malformed producer evidence as a digest-bound failure before fixed-input admission. */
export const LiveReserveSnapshotProvenanceSchema = z.preprocess((value) => {
  if (value == null || typeof value !== "object") return value;
  let admitted = value;
  if ("reserveObservation" in admitted && admitted.reserveObservation !== undefined &&
      !ReserveObservationEnvelopeSchema.safeParse(admitted.reserveObservation).success) {
    admitted = { ...admitted, reserveObservation: undefined, reserveObservationFailure: {
      code: "producer-failed", reason: "malformed-reserve-observation",
      sourceSha256: sha256Hex(stableJsonStringifyV1(admitted.reserveObservation)),
    } };
  }
  if ("lenderBookObservation" in admitted && admitted.lenderBookObservation !== undefined) {
    const canonical = canonicalizeLenderBookObservation(admitted.lenderBookObservation);
    admitted = LenderBookObservationSchema.safeParse(canonical).success
      ? { ...admitted, lenderBookObservation: canonical }
      : { ...admitted, lenderBookObservation: undefined, lenderBookObservationFailure: {
        code: "producer-failed", reason: "malformed-lender-book-observation",
        sourceSha256: sha256Hex(stableJsonStringifyV1(admitted.lenderBookObservation)),
      } };
  }
  return admitted;
}, LiveReserveSnapshotProvenanceShapeSchema);
