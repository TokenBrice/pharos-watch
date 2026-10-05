import { isRecord } from "@shared/lib/type-guards";
import type { DexRequestBudget } from "@shared/types/measured-execution";
import { readDexApiJson } from "../direct-api-json";
import { suiUint } from "./state-reader";

export type SuiTransactionCheckpointResolver = (digests: readonly string[]) => Promise<unknown[]>;

/** Full nodes prune old transaction indexing while their current dynamic fields
 * remain live. The official archival GraphQL service supplies the missing actual
 * transaction checkpoint; absence/error never becomes a guessed creation pin. */
export function createSuiTransactionCheckpointResolver(input: {
  signal: AbortSignal; budget: DexRequestBudget;
}): SuiTransactionCheckpointResolver {
  return async (digests) => {
    if (digests.length < 1 || digests.length > 50 || digests.some((digest) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(digest))) throw new Error("sui-archive-invalid-digests");
    if (input.signal.aborted || !input.budget.tryConsume()) throw new Error("sui-archive-budget-exhausted");
    const query = `{ ${digests.map((digest, i) => `t${i}: transaction(digest: "${digest}") { digest effects { checkpoint { sequenceNumber digest } } }`).join(" ")} }`;
    let response: Response;
    try {
      response = await fetch("https://graphql.mainnet.sui.io/graphql", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: input.signal });
    } catch { throw new Error("sui-archive-transport-failed"); }
    const parsed = await readDexApiJson<Record<string, unknown>>(response, "sui-clmm-archive", 256 * 1024);
    if (!response.ok || !parsed.ok || parsed.data.errors != null || !isRecord(parsed.data.data)) throw new Error("sui-archive-response-failed");
    const data = parsed.data.data;
    return digests.map((digest, i) => {
      const transaction = data[`t${i}`];
      if (!isRecord(transaction) || transaction.digest !== digest || !isRecord(transaction.effects) || !isRecord(transaction.effects.checkpoint) || typeof transaction.effects.checkpoint.digest !== "string") throw new Error("sui-archive-transaction-unavailable");
      return { digest, checkpoint: suiUint(transaction.effects.checkpoint.sequenceNumber).toString(),
        checkpointDigest: transaction.effects.checkpoint.digest, source: "sui-graphql-archive" };
    });
  };
}
