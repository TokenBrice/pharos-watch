import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCandidReply, icpLabelId, icpLebEncode } from "../icp";
import { jsonResponse, mockFetch } from "@shared/test-utils/mock-fetch";
import { decodeIcpQueryFixture, icpReplyFixtureResponse } from "./icp-gldt.test-support";
import { expectValidAdapterOutput, resolveAdapterCoin } from "./reserve-adapter.test-support";
import {
  adaptIcpGldtState,
  encodeIcpGldtBalanceOfArg,
  fetchIcpGldtReserves,
  parseIcpGldtSwapConfigs,
  type IcpGldtState,
} from "../icp-gldt";

const SWAP = "6f6ua-hqaaa-aaaar-qairq-cai";
const LEDGER = "6c7su-kiaaa-aaaar-qaira-cai";
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const PARAMS = {
  swapCanisterId: SWAP,
  ledgerCanisterId: LEDGER,
  label: "Locked GLD NFTs representing physical gold bars in Swiss vaults",
  risk: "low" as const,
};

// Live `get_swap_configs` reply from the GLDT swap canister (221 bytes). Its
// `GeneralFractionalizationConfig` declares `division, ledger_id, swap_fee`; a
// hand-written fixture had assumed `division, swap_fee, ledger_id`, which made
// every prod run fail on `swap_fee is not a candid nat`.
const SWAP_CONFIG_REPLY = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "icp-gldt-get-swap-configs.json"), "utf8"),
) as { capturedAt: string; source: string; replyHex: string };

// LEB128 of `icpLabelId("swap_fee")` in the capture's type table, which is where
// the field's label sits. Unique in this reply.
const SWAP_FEE_LABEL_HEX = "dae6edd508";

// The four GLD NFT denominations recorded by the census: 1g (85), 10g (26),
// 100g (6), 1000g (5) = 5,945 g locked, with each `division` expressed in
// 8-dp GLDT base units (100 GLDT per gram -> 10^10 base units per gram) and the
// 0.9 GLDT per-swap fee the canister reports.
const SWAP_CONFIGS = [
  { canisterId: "io7gn-vyaaa-aaaak-qcbiq-cai", divisionBaseUnits: 10n ** 10n, swapFeeBaseUnits: 90_000_000n, ledgerId: LEDGER },
  { canisterId: "sy3ra-iqaaa-aaaao-aixda-cai", divisionBaseUnits: 10n ** 11n, swapFeeBaseUnits: 90_000_000n, ledgerId: LEDGER },
  { canisterId: "zhfjc-liaaa-aaaal-acgja-cai", divisionBaseUnits: 10n ** 12n, swapFeeBaseUnits: 90_000_000n, ledgerId: LEDGER },
  { canisterId: "7i7jl-6qaaa-aaaam-abjma-cai", divisionBaseUnits: 10n ** 13n, swapFeeBaseUnits: 90_000_000n, ledgerId: LEDGER },
];

const BALANCES = [85n, 26n, 6n, 5n];
// Recorded census supply: 594,499.7 GLDT in 8-dp base units.
const SUPPLY = 59_449_970_000_000n;

function state(overrides: Partial<IcpGldtState> = {}): IcpGldtState {
  return {
    swapConfigs: SWAP_CONFIGS,
    balances: BALANCES,
    supplyBaseUnits: SUPPLY,
    certifiedTimeNanos: 1_752_600_000_000_000_000n,
    ...overrides,
  };
}

describe("parseIcpGldtSwapConfigs", () => {
  it("reads the live reply by candid field label", () => {
    const configs = parseIcpGldtSwapConfigs(
      decodeCandidReply(Uint8Array.from(Buffer.from(SWAP_CONFIG_REPLY.replyHex, "hex"))),
    );

    expect(configs).toEqual(SWAP_CONFIGS);
  });

  it("fails closed when the reply no longer labels a field instead of shifting values into its place", () => {
    const renamed = SWAP_CONFIG_REPLY.replyHex.replace(
      SWAP_FEE_LABEL_HEX,
      Buffer.from(icpLebEncode(BigInt(icpLabelId("ledger")))).toString("hex"),
    );
    const reply = Uint8Array.from(Buffer.from(renamed, "hex"));
    // Three fields survive in the record, so a positional reader would publish
    // the `ledger_id` principal as the swap fee.
    expect(() => parseIcpGldtSwapConfigs(decodeCandidReply(reply))).toThrow(/missing its swap_fee field/);
  });
});

describe("encodeIcpGldtBalanceOfArg", () => {
  it("encodes the icrc7_balance_of account the way the canister's candid parser accepts", () => {
    // The canister traps on a record field that inlines a composite opcode
    // ("unknown opcode -18": an inline `opt` subaccount), so composite field
    // types must be type-table references. The live canisters answered
    // 85/26/6/5 for exactly these bytes.
    expect(Buffer.from(encodeIcpGldtBalanceOfArg(SWAP)).toString("hex")).toBe(
      "4449444c046d7b6e006c02b3b0dac30368ad86ca8305016d02010301010a0000000002300223010100",
    );
  });
});

describe("adaptIcpGldtState", () => {
  it("measures the recorded census of 5,945 locked grams against 594,499.7 GLDT", () => {
    const result = adaptIcpGldtState(state(), PARAMS);

    expect(result.slices).toEqual([
      { sourceKey: "icp-gldt:locked-gld-nft", name: PARAMS.label, pct: 100, risk: "low" },
    ]);
    expect(result.metadata?.freshnessMode).toBe("not-applicable");
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(5945, 6);
    expect(result.metadata?.supplyTokens).toBeCloseTo(594_499.7, 6);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.0000005, 6);
    expect(result.metadata?.details?.lockedGrams).toBeCloseTo(5945, 6);
    expect(result.metadata?.details?.supplyGrams).toBeCloseTo(5944.997, 6);
    expect(result.metadata?.details?.certifiedStateTimeSec).toBe(1_752_600_000);
    expect(result.warnings).toBeUndefined();
  });

  it("fails closed when a swap config targets a different ledger than the pinned one", () => {
    const mismatched = SWAP_CONFIGS.map((config, index) =>
      index === 2 ? { ...config, ledgerId: "tyyy3-4aaaa-aaaaq-aab7a-cai" } : config,
    );
    expect(() => adaptIcpGldtState(state({ swapConfigs: mismatched }), PARAMS)).toThrow(
      "targets ledger tyyy3-4aaaa-aaaaq-aab7a-cai",
    );
  });

  it("degrades when locked gold falls below the GLDT supply in gram terms", () => {
    const result = adaptIcpGldtState(
      state({ balances: [85n, 26n, 6n, 4n] }),
      PARAMS,
    );

    expect(result.warnings?.some((warning) => warning.code === "reserve-undercollateralized")).toBe(true);
    expect(result.metadata?.collateralizationRatio).toBeLessThan(0.995);
  });

  it("throws when no NFT canisters are reported", () => {
    expect(() => adaptIcpGldtState(state({ swapConfigs: [] }), PARAMS)).toThrow("no canister configs");
  });
});

describe("fetchIcpGldtReserves query boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["icp0.io", "ic0.app"])("preserves exact uint64 ingress expiry through the GLDT fetch boundary (%s)", async (boundaryHost) => {
    const nowMs = 1_791_504_000_123;
    const expectedExpiry = BigInt(nowMs + 300_000) * 1_000_000n;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const queries: Array<{ canisterId: string; methodName: string; expiry: bigint; integerHeaders: number[] }> = [];
    const failedHosts: string[] = [];
    const fetchSpy = mockFetch([
      {
        match: `https://icrc-api.internetcomputer.org/api/v1/ledgers/${LEDGER}`,
        respond: () => jsonResponse({ icrc1_metadata: { icrc1_total_supply: SUPPLY.toString() } }),
      },
      {
        match: (request) => new URL(request.url).pathname.endsWith("/query"),
        respond: async (request) => {
          const decoded = decodeIcpQueryFixture(new Uint8Array(await request.arrayBuffer()));
          const content = decoded.value instanceof Map ? decoded.value.get("content") : null;
          if (!(content instanceof Map)) throw new Error("missing query content");
          const expiry = content.get("ingress_expiry");
          // Model the IC boundary's expiry validation, not a mocked query helper.
          if (typeof expiry !== "bigint" || expiry <= BigInt(nowMs) * 1_000_000n
            || expiry !== expectedExpiry || decoded.integerHeaders[0] !== 0x1b) {
            return new Response("invalid ingress expiry", { status: 400 });
          }
          const url = new URL(request.url);
          if (url.hostname !== boundaryHost) {
            failedHosts.push(url.hostname);
            return new Response("boundary unavailable", { status: 400 });
          }
          const canisterId = url.pathname.split("/")[4];
          if (!canisterId) throw new Error("missing query canister identity");
          const methodName = content.get("method_name");
          if (typeof methodName !== "string") throw new Error("missing query method");
          queries.push({ canisterId, methodName, expiry, integerHeaders: decoded.integerHeaders });
          if (canisterId === SWAP && methodName === "get_swap_configs") {
            return icpReplyFixtureResponse(Uint8Array.from(Buffer.from(SWAP_CONFIG_REPLY.replyHex, "hex")));
          }
          const index = SWAP_CONFIGS.findIndex((config) => config.canisterId === canisterId);
          if (index < 0 || methodName !== "icrc7_balance_of") throw new Error("unexpected canister query");
          expect(content.get("arg")).toEqual(encodeIcpGldtBalanceOfArg(SWAP));
          // Candid (vec nat) with one balance; all recorded balances fit one LEB byte.
          const reply = Uint8Array.from([...Buffer.from("4449444c016d7d010001", "hex"), Number(BALANCES[index])]);
          return icpReplyFixtureResponse(reply);
        },
      },
    ], { requireMatch: true });
    const { coin, config } = resolveAdapterCoin("icp-gldt", "gldt-gold-dao");

    const result = await fetchIcpGldtReserves(coin, config, new AbortController().signal);

    expectValidAdapterOutput("icp-gldt", result, { now: Math.floor(nowMs / 1000) });
    expect(result.metadata?.totalReserveQuantity).toBeCloseTo(5945, 6);
    expect(result.metadata?.supplyTokens).toBeCloseTo(594_499.7, 6);
    expect(queries).toHaveLength(5);
    expect(queries.map((query) => query.canisterId).sort()).toEqual([SWAP, ...SWAP_CONFIGS.map((config) => config.canisterId)].sort());
    expect(queries.every((query) => query.expiry === expectedExpiry && query.integerHeaders.length === 1)).toBe(true);
    expect(failedHosts.length > 0).toBe(boundaryHost === "ic0.app");
    fetchSpy.assertAllRoutesUsed();
  });
});
