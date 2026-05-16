/**
 * Google Sheets / Excel IMPORTDATA-friendly endpoint constants (idea 11.8).
 *
 * Per research/07-power-user.md §11.8, Sheets variants are flat-schema CSVs
 * served with CORS, short max-age, and `Content-Disposition: inline` so that
 * `=IMPORTDATA("https://pharos.watch/sheets/<topic>.csv")` works.
 *
 * Sheets variants are emitted by the same prebuild script that produces the
 * `/datasets/<topic>/...` mirrors; both URL families share the underlying
 * snapshot substrate.
 */
import { SITE_ORIGIN } from "../runtime-origins";
import { PUBLIC_DATASET_TOPICS, type PublicDatasetTopic } from "./datasets";

/**
 * Sheets exposes the same topic identifiers as `/datasets/`. Keep them tied
 * to a single source of truth so the two URL surfaces never drift.
 */
export const PUBLIC_SHEETS_TOPICS = PUBLIC_DATASET_TOPICS;
export type PublicSheetsTopic = PublicDatasetTopic;

/** Build a `/sheets/<topic>.csv` path. */
export function pathPublicSheet(topic: PublicSheetsTopic): string {
  return `/sheets/${topic}.csv`;
}

/** Build the absolute URL of a Sheets-friendly CSV mirror. */
export function urlPublicSheet(topic: PublicSheetsTopic): string {
  return `${SITE_ORIGIN}${pathPublicSheet(topic)}`;
}
