import { isRecord } from "@shared/lib/type-guards";
import type { DexRequestBudget } from "@shared/types/measured-execution";
import { fetchTextWithRetry, type FetchWithRetryBodyResult } from "../../../lib/fetch-retry";
import { parseJson } from "../../../lib/json-parse";
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
    let fetched: FetchWithRetryBodyResult<string> | null;
    try {
      // Preserve the shared request budget: exactly one bounded attempt.
      fetched = await fetchTextWithRetry("https://graphql.mainnet.sui.io/graphql", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: input.signal }, 0, {
        timeoutMs: Math.max(1, Math.min(15_000, input.budget.deadlineMs - Date.now())),
        maxResponseBytes: 256 * 1024, returnFinalResponse: true,
      });
    } catch { throw new Error("sui-archive-transport-failed"); }
    if (!fetched) throw new Error("sui-archive-transport-failed");
    const parsed = parseJson(fetched.body);
    if (!fetched.response.ok || !parsed.ok || !isRecord(parsed.value) || parsed.value.errors != null || !isRecord(parsed.value.data)) throw new Error("sui-archive-response-failed");
    const data = parsed.value.data;
    return digests.map((digest, i) => {
      const transaction = data[`t${i}`];
      if (!isRecord(transaction) || transaction.digest !== digest || !isRecord(transaction.effects) || !isRecord(transaction.effects.checkpoint) || typeof transaction.effects.checkpoint.digest !== "string") throw new Error("sui-archive-transaction-unavailable");
      return { digest, checkpoint: suiUint(transaction.effects.checkpoint.sequenceNumber).toString(),
        checkpointDigest: transaction.effects.checkpoint.digest, source: "sui-graphql-archive" };
    });
  };
}
