import { CHAIN_META } from "@shared/types/chain-identity";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { parseXrplIssuedCurrencyAmount } from "@shared/lib/deployment-amounts";
import type { EconomicSupplyObservation, EconomicSupplyReference, ReviewedEconomicSupplyPlan, ReviewedEconomicDeploymentPartition } from "@shared/types/safety-score-v9-supply-attribution";
import type { SupplyAttributionRejectionCode } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { getRpcAuthHeaders, type ChainRpcConfig } from "../chain-registry";
import { fetchEvmBlockHeader, fetchEvmBlockNumber, fetchEvmMulticall3Aggregate3AtBlock, fetchEvmRpcBatch, type EvmBlockHeader } from "../evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../evm-selectors";
import { getPublicRpcUrl } from "../public-rpc-registry";
import { decodeEvmUint256, fetchSafetyScoreV9SolanaRpc, rewindEvmBlockHeaderToScoringClock, type SafetyScoreV9SolanaRpcFetcher } from "./supply-observation-primitives";
import { buildReviewedEconomicDeploymentInventory, deriveReviewedEconomicDeploymentPartition, economicProviderSupplyContradictionChain, REVIEWED_ECONOMIC_SUPPLY_PLANS } from "./supply-attribution-contract";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";

/** Finalized mint snapshot, case-preserved identity, pinned chronology and response hash. */
export async function observeEconomicSolanaMint(input: {
  address: string; decimals: number; programOwner?: string; clockSec: number;
  /** Economic accounting needs the exact context block; active transfer reads retain skipped-slot semantics. */
  requireExactContextSlot?: boolean;
  chainRpcs?: Map<string, ChainRpcConfig>; signal?: AbortSignal;
}, rpc?: SafetyScoreV9SolanaRpcFetcher): Promise<{ amount: string; slot: string; blockHash: string; observedAtSec: number; responseSha256: string } | null> {
  const read: SafetyScoreV9SolanaRpcFetcher = rpc ?? ((method, params, signal) => fetchSafetyScoreV9SolanaRpc(method, params, signal, input.chainRpcs));
  const account = await read<{ context?: { slot?: number }; value?: { owner?: string; data?: { parsed?: { type?: string; info?: { supply?: string; decimals?: number } } } } }>("getAccountInfo", [input.address, { commitment: "finalized", encoding: "jsonParsed" }], input.signal);
  const info = account?.value?.data?.parsed?.info;
  const slot = account?.context?.slot;
  const owner = account?.value?.owner;
  if (!Number.isSafeInteger(slot) || slot! < 0 || account?.value?.data?.parsed?.type !== "mint" || !info || typeof info.supply !== "string" || !/^(0|[1-9][0-9]*)$/.test(info.supply) || info.decimals !== input.decimals ||
    (owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && owner !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") || (input.programOwner !== undefined && owner !== input.programOwner)) return null;
  const startSlot = input.requireExactContextSlot ? slot! : Math.max(0, slot! - 64);
  const slots = await read<number[]>("getBlocks", [startSlot, slot, { commitment: "finalized", minContextSlot: slot }], input.signal);
  if (!Array.isArray(slots)) return null;
  const anchor = input.requireExactContextSlot
    ? slots.length === 1 && slots[0] === slot ? slot! : null
    : slots.filter(value => Number.isSafeInteger(value) && value >= startSlot && value <= slot!)
      .reduce<number | null>((latest, value) => latest === null || value > latest ? value : latest, null);
  if (anchor === null) return null;
  const block = await read<{ blockTime?: number; blockhash?: string }>("getBlock", [anchor, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }], input.signal);
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  if (!block || !Number.isInteger(block.blockTime) || block.blockTime! < 0 || block.blockTime! > input.clockSec || input.clockSec - block.blockTime! > policy.observationMaxAgeSec || typeof block.blockhash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.blockhash)) return null;
  // Hash the score-bearing RPC response projection. Incidental rentEpoch is u64
  // and may be an unsafe JS number; it is neither quantity nor identity evidence.
  return { amount: info.supply, slot: `${slot}:${anchor}`, blockHash: block.blockhash, observedAtSec: block.blockTime!, responseSha256: sha256Hex(stableJsonStringifyV1({
    address: input.address, accountSlot: slot, owner, parsedType: account!.value!.data!.parsed!.type,
    supply: info.supply, decimals: info.decimals, blockSlot: anchor, blockTime: block.blockTime, blockhash: block.blockhash,
  })) };
}

async function readReviewedApiAmount(source: ReviewedEconomicSupplyPlan["conversionSources"][number], signal?: AbortSignal): Promise<EconomicSupplyReference | null> {
  const response = await fetch(source.url, { signal });
  const text = await response.text();
  if (!response.ok) return null;
  const body: unknown = JSON.parse(text);
  const field = (path: string[]) => path.reduce<unknown>((value, key) => value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined, body);
  const value = field(source.amountPath), observedAt = field(source.observedAtPath), generation = field(source.generationPath);
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored canonical unsigned-decimal shape; groups cannot overlap.
  if ((typeof value !== "string" && typeof value !== "number") || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(String(value)) || typeof observedAt !== "number" || !Number.isInteger(observedAt) || observedAt < 0 || typeof generation !== "string" || generation.length === 0) return null;
  return { sourceId: source.sourceId, sourceGeneration: generation, value: String(value), observedAtSec: observedAt, responseSha256: sha256Hex(text) };
}

export type ReviewedEconomicSupplyObservationAttempt =
  | { status: "accepted"; attribution: ReviewedEconomicDeploymentPartition }
  | { status: "rejected"; rejectionCode: SupplyAttributionRejectionCode; failedRouteId: string | null; rejectedSourceObservedAtSec?: number | null };

/** Reads only the reviewed census. The aggregate is always copied from admitted source input. */
export async function observeReviewedEconomicDeploymentPartitionAttempt(input: {
  assetId: string; fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>; chainRpcs: Map<string, ChainRpcConfig>; signal?: AbortSignal;
}): Promise<ReviewedEconomicSupplyObservationAttempt> {
  let failedRouteId: string | null = null;
  try {
    const inventory = buildReviewedEconomicDeploymentInventory(input.assetId);
    const plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(input.assetId);
    if (!inventory || !plan) return { status: "rejected", rejectionCode: "route-inventory-unavailable", failedRouteId: null };
    const aggregate = input.fixedInput.aggregateCirculatingById[input.assetId];
    const aggregateUsd = getCirculatingRawOrNull(aggregate ?? {});
    const price = input.fixedInput.navPriceById?.[input.assetId];
    if (aggregateUsd === null || aggregate?.observedAtSec == null) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: null };
    const observations: EconomicSupplyObservation[] = [], inFlight: EconomicSupplyObservation[] = [], conversions: EconomicSupplyReference[] = [];
    const referencePrice: EconomicSupplyReference | null = plan.referencePriceSource
      ? await readReviewedApiAmount(plan.referencePriceSource, input.signal)
      : price ? { sourceId: price.sourceId, value: String(price.priceUsd), sourceGeneration: input.fixedInput.sourceGeneration, observedAtSec: price.observedAtSec, responseSha256: sha256Hex(stableJsonStringifyV1(price)) } : null;
    if (!referencePrice || Number(referencePrice.value) <= 0) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: plan.sourceId };
    const headers = new Map<string, EvmBlockHeader>();
    const readEvm = async (row: ReviewedEconomicSupplyPlan["deployments"][number], id: string, account?: string): Promise<EconomicSupplyObservation | null> => {
      if (CHAIN_META[row.chainId]?.type !== "evm" || row.address === null) return null;
      let header = headers.get(row.chainId);
      if (!header) {
        const options = { chainRpcs: input.chainRpcs, signal: input.signal };
        const head = await fetchEvmBlockNumber(row.chainId, options);
        const lag = Math.max(...plan.deployments.filter(other => other.chainId === row.chainId).map(other =>
          "safeBlockLag" in other.read ? other.read.safeBlockLag : 0));
        if (head === null || lag <= 0 || head < lag) return null;
        const block = await rewindEvmBlockHeaderToScoringClock({
          initialBlockNumber: head - lag, scoringClockSec: input.fixedInput.clockSec, signal: input.signal,
          fetchHeader: number => fetchEvmBlockHeader(row.chainId, number, options),
        });
        if (!block) return null;
        header = block; headers.set(row.chainId, header);
      }
      if (account !== undefined && !/^0x[0-9a-f]{40}$/.test(account)) return null;
      if (row.holdingKind === "native-gas" && account !== undefined) {
        const result = await fetchEvmRpcBatch(row.chainId, [{ method: "eth_getBalance", params: [account, { blockHash: header.hash, requireCanonical: true }] }], { chainRpcs: input.chainRpcs, signal: input.signal });
        const value = result?.[0];
        if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
        const wei = BigInt(value).toString().padStart(19, "0");
        const amount = `${wei.slice(0, -18)}.${wei.slice(-18)}`.replace(/0+$/, "").replace(/\.$/, "");
        return { id, deploymentKey: row.deploymentKey, amount, observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash, responseSha256: sha256Hex(stableJsonStringifyV1({ result, header, account })) };
      }
      if (row.decimals === null) return null;
      const calls = [
        { label: id, target: row.address, callData: account === undefined ? TOTAL_SUPPLY_SELECTOR : `0x70a08231${account.slice(2).padStart(64, "0")}`, allowFailure: true },
        { label: `${id}:decimals`, target: row.address, callData: DECIMALS_SELECTOR, allowFailure: true },
      ];
      const results = await fetchEvmMulticall3Aggregate3AtBlock(row.chainId, calls, header.number, { chainRpcs: input.chainRpcs, signal: input.signal, stateBlockHash: header.hash, multicallFallbackBlockHash: header.hash });
      const value = results && decodeEvmUint256(results[0]), decimals = results && decodeEvmUint256(results[1]);
      if (value == null || decimals == null || decimals !== BigInt(row.decimals)) return null;
      return { id, deploymentKey: row.deploymentKey, amount: value.toString(), observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash, responseSha256: sha256Hex(stableJsonStringifyV1({ calls, results, header })) };
    };
    const readPendingState = async (
      source: Extract<NonNullable<ReviewedEconomicSupplyPlan["escrows"][number]["inFlightSource"]>, { kind: "evm-pending-state" }>,
      escrow: ReviewedEconomicSupplyPlan["escrows"][number],
    ): Promise<EconomicSupplyObservation | null> => {
      const header = headers.get(source.chainId);
      if (!header) return null;
      const options = { chainRpcs: input.chainRpcs, signal: input.signal };
      const finalized = await fetchEvmBlockHeader(source.chainId, "finalized", options);
      if (!finalized || finalized.number < header.number) return null;
      // EIP-1898 binds every state read to the exact already-observed escrow
      // block hash. Unsupported hash-pinned reads reject; no latest fallback.
      const block = { blockHash: header.hash, requireCanonical: true };
      const state = await fetchEvmRpcBatch(source.chainId, [
        { method: "eth_getCode", params: [source.bridgeAddress, block] },
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.messageCountSelector }, block] },
      ], options);
      if (!state || state.length !== 2 || typeof state[0] !== "string" ||
        !/^0x[0-9a-f]+$/i.test(state[0]) || state[0].length % 2 !== 0 ||
        sha256Hex(state[0].toLowerCase()) !== source.bridgeRuntimeCodeSha256 ||
        typeof state[1] !== "string" || !/^0x[0-9a-f]{64}$/i.test(state[1]) ||
        BigInt(state[1]) !== BigInt(source.messageIds.length)) return null;
      const calls = source.messageIds.flatMap((messageId, index) => [
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.messageIdSelector + index.toString(16).padStart(64, "0") }, block] },
        { method: "eth_call", params: [{ to: source.bridgeAddress, data: source.pendingAmountSelector + messageId.slice(2) }, block] },
      ]);
      const messages = calls.length === 0 ? [] : await fetchEvmRpcBatch(source.chainId, calls, options);
      if (!messages || messages.length !== calls.length) return null;
      let amount = 0n;
      for (let index = 0; index < source.messageIds.length; index++) {
        const identity = messages[index * 2], value = messages[index * 2 + 1];
        if (typeof identity !== "string" || identity.toLowerCase() !== source.messageIds[index] ||
          typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return null;
        amount += BigInt(value);
      }
      return { id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey,
        amount: amount.toString(), observedAtSec: header.timestamp, anchor: String(header.number), anchorHash: header.hash,
        responseSha256: sha256Hex(stableJsonStringifyV1({ source, state, calls, messages, header,
          sourceGeneration: input.fixedInput.sourceGeneration, baseInputGenerationId: input.fixedInput.baseInputGenerationId })) };
    };
    for (const row of plan.deployments) {
      throwIfAborted(input.signal); failedRouteId = row.routeId ?? row.deploymentKey;
      let observation: EconomicSupplyObservation | null = null;
      if (row.read.kind === "provider-chain") {
        const sameChain = plan.deployments.filter(other => other.chainId === row.chainId);
        const amount = input.fixedInput.chainCirculatingById[input.assetId]?.[row.read.sourceChain]?.current;
        if (sameChain.length === 1 && row.amountBasis === "circulating-usd" && amount !== undefined) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: String(amount), observedAtSec: aggregate.observedAtSec, anchor: input.fixedInput.sourceGeneration, anchorHash: sha256Hex(stableJsonStringifyV1(input.fixedInput.chainCirculatingById[input.assetId])), responseSha256: sha256Hex(stableJsonStringifyV1({ sourceChain: row.read.sourceChain, amount })) };
      } else if (row.read.kind === "evm-total-supply" || row.read.kind === "evm-balance") {
        observation = await readEvm(row, row.deploymentKey, row.read.kind === "evm-balance" ? row.read.account : undefined);
      } else if (row.read.kind === "solana-mint" && row.chainId === "solana" && row.address !== null && row.decimals !== null) {
        const result = await observeEconomicSolanaMint({ address: row.address, decimals: row.decimals, programOwner: row.read.programOwner, clockSec: input.fixedInput.clockSec, chainRpcs: input.chainRpcs, signal: input.signal, requireExactContextSlot: true });
        if (result) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: result.amount, observedAtSec: result.observedAtSec, anchor: result.slot, anchorHash: result.blockHash, responseSha256: result.responseSha256 };
      } else if (row.read.kind === "native-from-aggregate" && row.holdingKind === "native-gas" && row.amountBasis === "native-ledger") {
        const amount = aggregateUsd / Number(referencePrice.value);
        if (Number.isFinite(amount) && amount >= 0) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }), observedAtSec: Math.min(aggregate.observedAtSec, referencePrice.observedAtSec), anchor: `attributed:${input.fixedInput.sourceGeneration}`, anchorHash: sha256Hex(stableJsonStringifyV1({ aggregate, referencePrice })), responseSha256: sha256Hex(stableJsonStringifyV1({ aggregate, referencePrice })) };
      } else if (row.read.kind === "xrpl-issued-currency" && row.chainId === "xrpl") {
        const url = input.chainRpcs.get("xrpl")?.endpoints[0]?.url ?? getPublicRpcUrl("xrpl");
        if (url) {
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "gateway_balances", params: [{ account: row.read.issuer, ledger_index: "validated", strict: true }] }), signal: input.signal });
          const text = await response.text();
          const body = JSON.parse(text) as { result?: { validated?: boolean; ledger_index?: number; ledger_hash?: string; obligations?: Record<string, string> } };
          const result = body.result, value = result?.obligations?.[row.read.currency];
          if (response.ok && result?.validated === true && Number.isSafeInteger(result.ledger_index) && typeof result.ledger_hash === "string" && /^[A-Fa-f0-9]{64}$/.test(result.ledger_hash) && typeof value === "string") {
            const amount = parseXrplIssuedCurrencyAmount({ issuer: row.read.issuer, currency: row.read.currency, value }, row.read);
            if (!amount.coefficient.startsWith("-")) {
              const coefficient = amount.coefficient, exponent = amount.exponent;
              const decimal = exponent >= 0 ? coefficient + "0".repeat(exponent) : coefficient.length + exponent > 0 ? `${coefficient.slice(0, coefficient.length + exponent)}.${coefficient.slice(coefficient.length + exponent)}` : `0.${"0".repeat(-exponent - coefficient.length)}${coefficient}`;
              // Read the pinned ledger's true close clock; a response receipt clock is not a ledger clock.
              const ledgerResponse = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...getRpcAuthHeaders(url) }, body: JSON.stringify({ method: "ledger", params: [{ ledger_hash: result.ledger_hash }] }), signal: input.signal });
              const ledgerText = await ledgerResponse.text();
              const ledger = JSON.parse(ledgerText) as { result?: { ledger?: { close_time?: number; ledger_hash?: string } } };
              const close = ledger.result?.ledger?.close_time;
              if (ledgerResponse.ok && ledger.result?.ledger?.ledger_hash === result.ledger_hash && Number.isInteger(close)) observation = { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal, observedAtSec: close! + 946684800, anchor: String(result.ledger_index), anchorHash: result.ledger_hash.toLowerCase(), responseSha256: sha256Hex(text + ledgerText) };
            }
          }
        }
      }
      if (!observation) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
      observations.push(observation);
    }
    for (const rule of [...plan.exclusions, ...plan.escrows.map(escrow => ({ id: escrow.id, deploymentKey: escrow.canonicalDeploymentKey, account: escrow.account }))]) {
      const row = plan.deployments.find(row => row.deploymentKey === rule.deploymentKey)!;
      failedRouteId = row.routeId ?? row.deploymentKey;
      const observation = await readEvm(row, rule.id, rule.account);
      if (!observation) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
      observations.push(observation);
    }
    for (const source of plan.conversionSources) {
      const conversion = await readReviewedApiAmount(source, input.signal);
      if (!conversion || Number(conversion.value) <= 0) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: source.sourceId };
      conversions.push(conversion);
    }
    for (const escrow of plan.escrows) {
      for (const receipt of escrow.receiptClaimSources) {
        const claim = await readReviewedApiAmount(receipt.source, input.signal);
        if (!claim) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: receipt.deploymentKey };
        observations.push({ id: `receipt:${escrow.id}:${receipt.deploymentKey}`, deploymentKey: receipt.deploymentKey,
          amount: claim.value, observedAtSec: claim.observedAtSec, anchor: claim.sourceGeneration, anchorHash: claim.responseSha256, responseSha256: claim.responseSha256 });
      }
      if (escrow.inFlightSource === null) continue;
      failedRouteId = escrow.id;
      if ("kind" in escrow.inFlightSource) {
        const pending = await readPendingState(escrow.inFlightSource, escrow);
        if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: escrow.id };
        inFlight.push(pending);
      } else {
        const pending = await readReviewedApiAmount(escrow.inFlightSource, input.signal);
        if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: escrow.id };
        inFlight.push({ id: `in-flight:${escrow.id}`, deploymentKey: escrow.canonicalDeploymentKey, amount: pending.value, observedAtSec: pending.observedAtSec, anchor: pending.sourceGeneration, anchorHash: pending.responseSha256, responseSha256: pending.responseSha256 });
      }
    }
    if (plan.liabilityInFlightSource !== null) {
      const pending = await readReviewedApiAmount(plan.liabilityInFlightSource, input.signal);
      if (!pending) return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: "in-flight:liability" };
      inFlight.push({ id: "in-flight:liability", deploymentKey: plan.deployments[0]!.deploymentKey, amount: pending.value,
        observedAtSec: pending.observedAtSec, anchor: pending.sourceGeneration, anchorHash: pending.responseSha256, responseSha256: pending.responseSha256 });
    }
    for (const [chainId, header] of headers) {
      const rechecked = await fetchEvmBlockHeader(chainId, header.number, { chainRpcs: input.chainRpcs, signal: input.signal });
      if (!rechecked || rechecked.number !== header.number || rechecked.hash !== header.hash || rechecked.timestamp !== header.timestamp) {
        return { status: "rejected", rejectionCode: "deployment-state-invalid", failedRouteId: `anchor:${chainId}` };
      }
    }
    const attribution = deriveReviewedEconomicDeploymentPartition({ plan, baseInputGenerationId: input.fixedInput.baseInputGenerationId, sourceGeneration: input.fixedInput.sourceGeneration, registryFingerprint: input.fixedInput.registryFingerprint, clockSec: input.fixedInput.clockSec, aggregate: { supplyUsd: aggregateUsd, observedAtSec: aggregate.observedAtSec, sourceGeneration: input.fixedInput.sourceGeneration }, referencePrice, conversions, observations, inFlight });
    if (attribution) {
      const contradiction = economicProviderSupplyContradictionChain(attribution, input.fixedInput.chainCirculatingById[input.assetId] ?? {});
      if (contradiction !== null) return { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId: `provider:${contradiction}` };
    }
    return attribution ? { status: "accepted", attribution } : { status: "rejected", rejectionCode: "packet-reconciliation-failed", failedRouteId };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return { status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId };
  }
}
