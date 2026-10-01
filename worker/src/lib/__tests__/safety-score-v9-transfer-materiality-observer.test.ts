import { describe, expect, it } from "vitest";
import { observeEconomicSolanaMint } from "../safety-score-v9/economic-supply-observer";
import type { SafetyScoreV9SolanaRpcFetcher } from "../safety-score-v9/supply-observation-primitives";

const ADDRESS = "USDai5XCUzNebYzUk6EuRiFCvnyoyEdj7VSyijYcz2A";
const PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const CLOCK = 1790850000;
function rpcFixture(options: { decimals?: number; owner?: string; slot?: number; observedAtSec?: number; hash?: string; missingAccount?: boolean; missingAnchor?: boolean } = {}): SafetyScoreV9SolanaRpcFetcher {
  return async <T>(method: string, params: unknown[]): Promise<T | null> => {
    if (method === "getAccountInfo") {
      expect(params).toEqual([ADDRESS, { commitment: "finalized", encoding: "jsonParsed" }]);
      return { context: { slot: options.slot ?? 100 }, value: options.missingAccount ? null : {
        owner: options.owner ?? PROGRAM, rentEpoch: 18446744073709552000,
        data: { parsed: { type: "mint", info: { decimals: options.decimals ?? 6, supply: "590514634" } } },
      } } as T;
    }
    if (method === "getBlocks") return (options.missingAnchor ? [] : [99]) as T;
    if (method === "getBlock") return { blockTime: options.observedAtSec ?? CLOCK - 30, blockhash: options.hash ?? "1".repeat(32) } as T;
    return null;
  };
}
describe("finalized economic Solana mint observations", () => {
  it("retains exact Token-2022 amount and case-preserved mint identity despite incidental u64 metadata", async () => {
    const result = await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture());
    expect(result).toMatchObject({ amount: "590514634", slot: "100:99", blockHash: "1".repeat(32), observedAtSec: CLOCK - 30 });
    expect(result!.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { decimals: 18 }, { owner: "incorrect-program" }, { slot: -1 }, { observedAtSec: CLOCK + 1 },
    { observedAtSec: CLOCK - 1801 }, { hash: "not-a-hash" }, { missingAccount: true }, { missingAnchor: true },
  ])("rejects invalid or unavailable source observations %j", async options => {
    expect(await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture(options))).toBeNull();
  });
  it("admits the exact 1800-second boundary without refreshing the original ledger clock", async () => {
    const result = await observeEconomicSolanaMint({ address: ADDRESS, decimals: 6, programOwner: PROGRAM, clockSec: CLOCK }, rpcFixture({ observedAtSec: CLOCK - 1800 }));
    expect(result!.observedAtSec).toBe(CLOCK - 1800);
  });
});
