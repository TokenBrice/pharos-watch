import { readJsonResponse } from "./api-request-response.test-support";
import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillBlacklistCurrentBalances } from "../backfill-blacklist-current-balances";

stubCryptoForAuth();

describe("handleBackfillBlacklistCurrentBalances", () => {
  it("selects current-balance candidates with config/contract scoped filters", async () => {
    const db = mockD1([
      {
        match: "FROM blacklist_events",
        rows: [{
          id: "optimism-usdt-row",
          stablecoin: "USDT",
          chain_id: "optimism",
          event_type: "blacklist",
          address: "0x1111111111111111111111111111111111111111",
          timestamp: 100,
        }],
      },
    ], { requireMatch: true });

    const request = makeApiRequest(
      "/api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=optimism&dryRun=true&limit=10",
      {
        method: "POST",
        adminKey: "secret-key",
      },
    );

    const response = await handleBackfillBlacklistCurrentBalances({ db, url: makeApiUrl("/api/backfill-blacklist-current-balances?stablecoin=USDT&chainId=optimism&dryRun=true&limit=10"), trustedAdmin: true, request });

    const body = await readJsonResponse(response, 200) as {
      dryRun: boolean;
      configs: Array<{ configKey: string; candidateCount: number; truncated: boolean }>;
      truncated: boolean;
      budgetExhausted: boolean;
      skippedDueBudget: number;
    };

    expect(body.dryRun).toBe(true);
    expect(body.configs.length).toBeGreaterThanOrEqual(2);
    expect(body.configs.every((config) => config.candidateCount === 1)).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.budgetExhausted).toBe(false);
    expect(body.skippedDueBudget).toBe(0);

    const selectSql = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events"))?.sql ?? "";
    expect(selectSql).toContain("config_key = ?");
    expect(selectSql).toContain("LOWER(contract_address) = LOWER(?)");
    expect(selectSql).toContain("config_key IS NULL AND contract_address IS NULL");
    expect(selectSql).toMatch(/WHERE rn = 1\s+ORDER BY timestamp DESC, id DESC\s+LIMIT \?/);
    expect(selectSql).not.toContain("ORDER BY timestamp ASC, id ASC");
  });
});
