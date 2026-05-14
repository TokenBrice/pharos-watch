import type { TapeEventSeverity, TapeEventTransition } from "@shared/types/tape-event";

/** D1 row shape for the tape_events table (snake_case columns). */
export interface TapeEventRow {
  id: number;
  event_id: string;
  type: string;
  severity: TapeEventSeverity;
  ts: number;                        // epoch ms
  ends_at: number | null;            // epoch ms
  coin_id: string | null;
  issuer_id: string | null;
  peg_currency: string | null;
  chain: string | null;
  title: string;
  summary: string;
  payload_json: string;
  source_table: string;
  source_row_id: string;
  transition: TapeEventTransition;
  source_url: string | null;
  methodology_version: string | null;
  created_at: number;                // epoch seconds
}

/** Input to the projector batch-insert helper. */
export interface TapeEventInsert {
  eventId: string;
  type: string;
  severity: TapeEventSeverity;
  ts: number;                        // epoch ms
  endsAt: number | null;             // epoch ms or null
  coinId: string | null;
  issuerId: string | null;
  pegCurrency: string | null;
  chain: string | null;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  sourceTable: string;
  sourceRowId: string;
  transition: TapeEventTransition;
  sourceUrl: string | null;
  methodologyVersion: string | null;
}
