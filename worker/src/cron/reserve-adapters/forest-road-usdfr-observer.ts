import { keccak256, parseAbi, stringToHex } from "viem/utils";
import { REDEMPTION_EXIT_CURVE_REQUESTS_USD } from "@shared/lib/exit-route-capacity-point";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import { abiObservation, type AnyEvmObservationField } from "./evm-observation-plan";
import { readStateWithPlan, type ExecutableRedemptionObserverDescriptor } from "./executable-redemption-observers";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CONTROLLER = "0x50ac018eb6400f247ffe0fa7f1d4e0e900cdb47c";
const RESERVE = "0x8317736611b542ddb4a820fe344b621a904bdd48";
const TOKEN = "0xcc07e7c4e5e35affd47b351e420a22c667d7f83d";
const COMPLIANCE = "0x1f9491817a039a0cc9781994f7b9e507ebaee062";
const SCALE = 10n ** 12n;
// Runtime and implementation identities captured at Ethereum 26143056; source evidence RD3.
const PROXY_HASH = "0xc935d7fce89600f808e1ee0728689f34cf1b9aa6d7163bdf56db81bd6350cf32";
const IDENTITIES = [
  { address: CONTROLLER, codeHash: PROXY_HASH, implementationAddress: "0x101adfc1a6fa8c5dfccd76db9f67541cf3f92e4d", implementationCodeHash: "0x447c092aa09aafb7b61251e88feff8262564f4d164a9f736c1a8161533ae2e1e" },
  { address: RESERVE, codeHash: PROXY_HASH, implementationAddress: "0x99b4dfa4e1344273d5335bd90de1dea3a02b9c3a", implementationCodeHash: "0xa08e17d75b3860c668345a0ab84beb4a7b221da3617f5eccf00f944d9c514716" },
  { address: TOKEN, codeHash: PROXY_HASH, implementationAddress: "0x9eef9b0b566c82e0802ced653dc8c0a5df1edc26", implementationCodeHash: "0x9ab436fd9e980982fcf26556fe62e55c0d31d2846d5ea5127beb54d70100b0c8" },
  { address: COMPLIANCE, codeHash: PROXY_HASH, implementationAddress: "0x52cb8a8aa3e31b2f554a5334e34f5ea8e9e597bb", implementationCodeHash: "0x825bf555be3ee72d5454096463b920fad6ea6383c90b4c2479a05edd58643d9a" },
] as const;
const ABI = parseAbi([
  "function modules() view returns (address,address,address)",
  "function paused() view returns (bool)",
  "function backingInvariantHolds() view returns (bool)",
  "function totalUSDfr() view returns (uint256)",
  "function recognizedBackingValue() view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256,uint256)",
  "function usdc() view returns (address)",
  "function idleUSDC() view returns (uint256)",
  "function idleCustodyShortfall() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function isBlacklisted(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function complianceModule() view returns (address)",
  "function reserveLossArm() view returns (uint256,uint256,bytes32,bool)",
  "function activeReserveLossIncident() view returns (uint256,bytes32)",
]);
function field(label: string, contract: string, functionName: string, args?: readonly unknown[]) {
  return abiObservation({ label, contract, abi: ABI, functionName, args });
}
function requireFact(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Error(`USDfr par observer: ${reason}`);
}

export const FOREST_ROAD_USDFR_OBSERVER: ExecutableRedemptionObserverDescriptor = {
  observerId: "usdfr-par-controller", coinId: "usdfr-forest-road", chain: "ethereum",
  inputContract: TOKEN, outputAssetKeys: ["usdc-circle"], capacityCapability: "measured", sourceLane: "direct",
  async observe(blockNumber, blockTimestamp, rpcOptions, client, ctx, signal) {
    const read = (label: string, fields: AnyEvmObservationField[], identities = IDENTITIES) =>
      readStateWithPlan("usdfr-forest-road", label, fields, identities, blockNumber, rpcOptions, client, ctx, signal);
    const { values: s } = await read("usdfr-par-state", [
      field("modules", CONTROLLER, "modules"), field("controller-paused", CONTROLLER, "paused"),
      field("backing-invariant", CONTROLLER, "backingInvariantHolds"), field("effective-supply", CONTROLLER, "totalUSDfr"),
      field("backing", CONTROLLER, "recognizedBackingValue"), field("usdc", RESERVE, "usdc"),
      field("idle", RESERVE, "idleUSDC"), field("custody-shortfall", RESERVE, "idleCustodyShortfall"),
      field("reserve-paused", RESERVE, "paused"),
      field("controller-role", RESERVE, "hasRole", [keccak256(stringToHex("CONTROLLER_ROLE")), CONTROLLER]),
      field("minter-role", TOKEN, "hasRole", [keccak256(stringToHex("MINTER_ROLE")), CONTROLLER]),
      field("token-paused", TOKEN, "paused"), field("token-decimals", TOKEN, "decimals"),
      field("supply", TOKEN, "totalSupply"), field("token-compliance", TOKEN, "complianceModule"),
      field("arm", RESERVE, "reserveLossArm"), field("incident", RESERVE, "activeReserveLossIncident"),
      field("physical", USDC, "balanceOf", [RESERVE]), field("usdc-decimals", USDC, "decimals"),
      field("usdc-paused", USDC, "paused"), field("reserve-blacklisted", USDC, "isBlacklisted", [RESERVE]),
    ]);
    const modules = s.modules as readonly string[];
    requireFact(modules.length === 3 && modules.map(x => x.toLowerCase()).join() === [TOKEN, COMPLIANCE, RESERVE].join(), "module identity drift");
    requireFact((s.usdc as string).toLowerCase() === USDC && (s["token-compliance"] as string).toLowerCase() === COMPLIANCE, "output/compliance identity drift");
    requireFact(s["token-decimals"] === 18 && s["usdc-decimals"] === 6, "decimal identity drift");
    requireFact(s["controller-role"] === true && s["minter-role"] === true, "controller release/burn authority revoked");
    const supply = s["effective-supply"] as bigint;
    const idle = s.idle as bigint;
    const physical = s.physical as bigint;
    const arm = s.arm as readonly [bigint, bigint, string, boolean];
    const incident = s.incident as readonly [bigint, string];
    const pause = ["controller-paused", "reserve-paused", "token-paused", "usdc-paused"].find(k => s[k] === true);
    const adverse = pause ?? (s["reserve-blacklisted"] ? "paying-reserve-blacklisted" :
      (s["custody-shortfall"] as bigint) > 0n || physical < idle ? "custody-shortfall" :
      arm[0] !== 0n && arm[1] !== incident[0] ? "unratified-reserve-loss-arm" : null);
    // Underbacking requires a junior draw or sub-par quote: neither is certified by this par-only strategy.
    requireFact(adverse != null || (s["backing-invariant"] === true && (s.backing as bigint) >= supply), "underbacking/junior-draw path unsupported");
    requireFact(supply > 0n && (s.supply as bigint) > 0n, "empty supply does not establish an executable holder route");
    const bound = [idle, physical, supply / SCALE].reduce((a, b) => a < b ? a : b);
    const quotes: { inputRaw: string; outputRaw: string; burnedRaw: string; supportedByInventory: boolean }[] = [];
    // Quotes are native-execution guards (including accrual), not just USD valuation inputs.
    // Missing all-in cost proof must block downstream USD admission, not weaken measured/open evidence.
    if (!adverse) {
      // A positive probe is necessary even for observed zero inventory: preview also checks accrual availability.
      const inputs = new Set<bigint>([supply / SCALE > 1_000_000n ? 10n ** 18n : (supply / SCALE) * SCALE]);
      if (bound > 0n) inputs.add(bound * SCALE);
      for (const n of [...REDEMPTION_EXIT_CURVE_REQUESTS_USD, ...EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd]) {
        if (BigInt(n) * 10n ** 18n <= supply) inputs.add(BigInt(n) * 10n ** 18n);
      }
      requireFact(!inputs.has(0n), "supply is below one native USDC unit");
      const fields = [...inputs].map(n => field(`preview-${n}`, CONTROLLER, "previewRedeem", [n]));
      const { values } = await read("usdfr-par-quotes", fields);
      for (const n of inputs) {
        const [out, burn] = values[`preview-${n}`] as readonly [bigint, bigint];
        requireFact(out === n / SCALE && burn === n, "non-par/rejected/rounded preview");
        quotes.push({ inputRaw: n.toString(), outputRaw: out.toString(), burnedRaw: burn.toString(), supportedByInventory: out <= bound });
      }
    }
    return {
      capacityRaw: adverse ? 0n : bound, capacityState: adverse ? "closed" : "measured",
      capacitySource: "usdfr-par-controller-guarded-usdc", underlyingDecimals: 6,
      settlementDelaySec: 0,
      capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", routeStatusSource: "onchain",
      routeStatus: adverse ? "paused" : "open", routeStatusReason: adverse ?? "Guarded par USDC inventory for the documented KYC-approved holder cohort",
      feeBps: 0, allInFeeBps: null, holderEligibility: "whitelisted-primary", outputAssetKeys: ["usdc-circle"],
      blockNumber, sourceTimestamp: blockTimestamp,
      sourceUrls: ["https://forestroadvault.com/docs/how-to", "https://forestroadvault.com/docs/roles-and-governance", ...IDENTITIES.map(i => `https://eth.blockscout.com/api/v2/smart-contracts/${i.implementationAddress}`)],
      diagnostics: { controller: CONTROLLER, payingReserve: RESERVE, outputAssetAddress: USDC,
        recordedIdleRaw: idle.toString(), physicalUsdcRaw: physical.toString(), effectiveSupplyRaw: supply.toString(),
        quotes, anyHolderCertified: false, walletEligibilityVerified: false, gasCostVerified: false,
        reserveCompositionUsedAsCapacity: false, parOnly: true },
    };
  },
};
