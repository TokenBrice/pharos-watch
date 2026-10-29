import { z } from "zod";
import {
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "./report-cards-v9";
import { ReportCardsV9NextResponseSchema } from "./report-cards-v9-next";

/**
 * Every in-repo reader of `GET /api/report-cards/v9` admits both wire contracts
 * during the expand step: report8, which the Worker still emits, and report9,
 * which train T1 will emit. Anything else fails closed, so a version this code
 * has never seen is never interpreted as a current report.
 */
export const ReportCardsV9AcceptedResponseSchema = z.discriminatedUnion("schemaVersion", [
  ReportCardsV9CurrentResponseSchema,
  ReportCardsV9NextResponseSchema,
]);
export type ReportCardsV9AcceptedResponse = z.infer<typeof ReportCardsV9AcceptedResponseSchema>;

/**
 * Reader view: readers still consume the report8 envelope, so report9-only
 * carriers are ignored (never rendered, never counted). The contract step drops
 * this shim and readers consume report9 directly; `schemaVersion` is normalised
 * to the reader contract so downstream types do not depend on the wire version.
 */
export function projectReportCardsV9ReaderResponse(
  response: ReportCardsV9AcceptedResponse,
): ReportCardsV9CurrentResponse {
  if (response.schemaVersion === REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION) return response;
  const {
    openEvidence: _openEvidence,
    openEvidenceUnavailableReason: _unavailableReason,
    documentationCauseGaps: _documentationCauseGaps,
    ...rest
  } = response;
  return { ...rest, schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION };
}

/** Drop-in reader parser for call sites that need a `ReportCardsV9CurrentResponse`. */
export const ReportCardsV9ReaderResponseSchema = ReportCardsV9AcceptedResponseSchema.transform(
  projectReportCardsV9ReaderResponse,
);
