import { makeBlacklistRow } from "../../../test-helpers/__shared/fixtures";
import type { BlacklistRow } from "../../../lib/blacklist/shared";

export function makePendingBlacklistRow(overrides: Partial<BlacklistRow> = {}): BlacklistRow {
  return {
    ...makeBlacklistRow(),
    amount_native: null,
    amount_usd_at_event: null,
    amount_source: "unavailable",
    amount_status: "recoverable_pending",
    timestamp: 1_710_000_000,
    methodology_version: "3.1",
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    ...overrides,
  };
}
