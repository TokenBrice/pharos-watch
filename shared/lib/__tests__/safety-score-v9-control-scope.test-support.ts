import { V9ControlExecutionScopeSchema, V9WeightedQuorumSchema } from "../../types/safety-score-v9-control-scope";
import type { V9ControlExecutionScope } from "../../types/safety-score-v9-control-scope";
export const SCOPE_CONTROLLER = "ethereum:0x1111111111111111111111111111111111111111";
export const SCOPE_CLOCK = Date.parse("2026-10-02T12:00:00Z") / 1000;
const pin = { position: "100", hash: "block-hash", runtimeIdentity: "runtime-a", signerIdentity: "signers-a" };
export function reviewedScope(overrides: Partial<V9ControlExecutionScope> = {}): V9ControlExecutionScope {
  return V9ControlExecutionScopeSchema.parse({
    controllerDeployment: SCOPE_CONTROLLER, reviewedAt: "2026-10-01", observedAt: "2026-10-01", expiresAt: "2026-10-31", reviewer: "independent reviewer", confidence: "verified", inventory: "complete",
    sources: [{ label: "Pinned executable", url: "https://example.com/source" }], pin, observedState: pin,
    closure: { entrypoints: true, mutableTargets: true, delegateAndFallback: true, permissions: true, upgrades: true, bypasses: true, liabilityInventory: true },
    paths: [{ id: "issuance", targetDeployment: SCOPE_CONTROLLER, entrypointKind: "evm-selector", entrypoints: ["0x40c10f19"], callMode: "call", capabilities: ["mint"], capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } }, claimImpairment: "bounded", economicLossScope: "global-claim", unavoidableDelaySec: null, activation: "active", affectedLiabilityIds: ["alpha"], affectedDeployments: [SCOPE_CONTROLLER], reach: "root", controlRefs: [], reactivationRefs: [], permissionChangeRefs: [], upgradeRefs: [], bypassRefs: [] }],
    extensions: { exhaustive: true, paginationEnd: "sentinel", sourceRuntimeCorrespondence: true, entries: [] },
    ...overrides,
  });
}
export function weightedQuorum(weights = [1, 1, 1, 3, 1, 1], quorum = 3) {
  return V9WeightedQuorumSchema.parse({
    scheme: "xrpl", deployment: "xrpl:rMkEuRii9w9uBMQDnWV5AA43gvYZR9JxVK", signers: weights.map((weight, index) => ({ account: ["riyP43AsZqAoVEr9hNnZVXMWBJjCttHmn", "rpFem93bCPKHBSk3Mo7tGAvzRnPBjpScgP", "r9QH6FpiV1SZpNrueSZNmuU7pKieUgr5es", "rMRvXUPc8cWPPYCBP2dWAWtAwSq3rjTSpi", "r4QhSH9FxnHFsaDsobbWABvQeNcrpKF3C1", "r4Y6BYpT48Jq318363wA37N3q87ovtuJQ8"][index] ?? `r${"1".repeat(24)}${"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[index]}`, weight })),
    quorum, masterKey: "disabled", regularKey: { state: "absent" }, pin: { ...pin, position: "107363734", runtimeIdentity: "xrpl-account-root" }, status: "verified", reviewedAt: "2026-10-01", expiresAt: "2026-10-31", reviewer: "fixture verifier", sources: [{ label: "Validated ledger", url: "https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_info" }],
  });
}
