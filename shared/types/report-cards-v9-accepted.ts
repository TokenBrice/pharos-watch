import { z } from "zod";
import {
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  HistoricalResolvedReportCardsV9ResponseSchema,
  projectArchivedReport8ToReader,
} from "./report-cards-v9";
import {
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "./report-cards-v9-current";

/**
 * Every in-repo reader of `GET /api/report-cards/v9` admits both wire contracts:
 * report8, the archive-only predecessor that the previous Worker still emits,
 * and report9, which this Worker emits. Anything else fails closed, so a
 * version this code has never seen is never interpreted as a current report.
 */
export const ReportCardsV9AcceptedResponseSchema = z.discriminatedUnion("schemaVersion", [
  ReportCardsV9CurrentResponseSchema,
  HistoricalResolvedReportCardsV9ResponseSchema,
]);
export type ReportCardsV9AcceptedResponse = z.infer<typeof ReportCardsV9AcceptedResponseSchema>;

/**
 * Reader view: readers consume the report9 contract, so a report8 payload is
 * normalised to report9 with `openEvidence: null` and the machine reason that
 * it predates the block — unavailable, never zero — and `schemaVersion` is
 * normalised so downstream types do not depend on the wire version.
 */
export function projectReportCardsV9ReaderResponse(
  response: ReportCardsV9AcceptedResponse,
): ReportCardsV9CurrentResponse {
  if (response.schemaVersion === REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION) return response;
  return projectArchivedReport8ToReader(response);
}

/** Drop-in reader parser for call sites that need a `ReportCardsV9CurrentResponse`. */
export const ReportCardsV9ReaderResponseSchema = ReportCardsV9AcceptedResponseSchema.transform(
  projectReportCardsV9ReaderResponse,
);
