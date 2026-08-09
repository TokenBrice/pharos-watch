import { DEPEG_SEVERITY_BPS } from "./depeg-config";

/**
 * Redemption-lane severity threshold (absolute bps).
 *
 * The Safety Score V8 overall-score caps that used to live beside this constant
 * were deleted with the V8 engine; the V9 methodology policy JSON is now the
 * sole owner of every score cap. This threshold is unrelated to scoring: it
 * gates redemption-backstop availability.
 */
export const REDEMPTION_SEVERE_ACTIVE_DEPEG_BPS = DEPEG_SEVERITY_BPS.severe;
