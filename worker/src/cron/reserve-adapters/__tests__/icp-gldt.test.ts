import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCandidReply, icpLabelId, icpLebEncode, icpPrincipalBytes, icpPrincipalText, queryIcpCanister } from "../icp";
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
    querySignatureTimeNanos: 1_752_600_000_000_000_000n,
    ...overrides,
  };
}

describe("ICP wire codecs", () => {
  it("rejects malformed CBOR under an external process deadline and preserves boundary fallback", async () => {
    // A synchronous decoder hang cannot be interrupted by a Vitest/AbortSignal timer
    // in that same process. The parent owns this child's kill deadline.
    const source = new URL("../icp.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { queryIcpCanister } from ${JSON.stringify(source)};
      const malformed = [
        "", "5f", "5f58", "5f5801", "5f4100", "5f6100ff", "5f5fff",
        "58", "5900", "5a000000", "5bffffffffffffffff", "5b0000000000000002ff",
        "7bffffffffffffffff", "9bffffffffffffffff", "bbffffffffffffffff",
        "9f", "bf6161", "81", "a100", "81".repeat(10000) + "00",
      ];
      const options = {
        canisterId: ${JSON.stringify(SWAP)}, methodName: "get_swap_configs",
        arg: new Uint8Array(), signal: new AbortController().signal,
      };
      const controller = new AbortController();
      const aborted = once(controller.signal, "abort");
      // Real timer integration: fake timers cannot expose event-loop starvation.
      setTimeout(() => controller.abort(), 0);
      for (const hex of malformed) {
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          return new Response(Buffer.from(hex, "hex"));
        };
        await assert.rejects(queryIcpCanister(options), /icp:/);
        assert.equal(calls, 2);
      }
      const valid = Buffer.from("a266737461747573677265706c696564657265706c79a1636172674144", "hex");
      let fallbackCalls = 0;
      globalThis.fetch = async () => new Response(++fallbackCalls === 1 ? Buffer.from("5f", "hex") : valid);
      assert.deepEqual(Array.from((await queryIcpCanister(options)).reply), [68]);
      assert.equal(fallbackCalls, 2);
      // Indefinite maps and chunked byte strings remain valid envelopes.
      globalThis.fetch = async () => new Response(Buffer.from(
        "bf66737461747573677265706c696564657265706c79bf636172675f4144ffffff", "hex"));
      assert.deepEqual(Array.from((await queryIcpCanister(options)).reply), [68]);
      await aborted;
      assert.equal(controller.signal.aborted, true);
      console.log(JSON.stringify({ rejected: malformed.length, fallbackCalls, abortTimerRan: true }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { timeout: 10_000, killSignal: "SIGKILL", cwd: fileURLToPath(new URL("../../../../../", import.meta.url).href) });
    expect(JSON.parse(stdout)).toEqual({ rejected: 20, fallbackCalls: 2, abortTimerRan: true });
  }, 15_000);

  it.each([1, 2, 4, 8])("decodes signed %i-byte boundaries without changing unsigned values", (width) => {
    const index = [1, 2, 4, 8].indexOf(width);
    const decode = (payload: number[], opcode = 0x77 - index) => decodeCandidReply(
      Uint8Array.from([0x44, 0x49, 0x44, 0x4c, 0, 1, opcode, ...payload]),
    )[0];
    const signBit = 1n << BigInt(width * 8 - 1);
    expect(decode(Array(width).fill(0xff))).toBe(-1n);
    expect(decode([...Array(width - 1).fill(0), 0x80])).toBe(-signBit);
    expect(decode([...Array(width - 1).fill(0xff), 0x7f])).toBe(signBit - 1n);
    expect(decode(Array(width).fill(0))).toBe(0n);
    expect(decode(Array(width).fill(0xff), 0x7b - index)).toBe(signBit * 2n - 1n);
  });

  it.each([
    { identity: [0x01, 0x02, 0x03] }, { identity: [0x00, 0x01] },
    { identity: [0x01] }, { identity: [0x04] },
  ])(
    "preserves every raw principal byte ($identity)", ({ identity }) => {
      const raw = Uint8Array.from(identity);
      expect(icpPrincipalBytes(icpPrincipalText(raw))).toEqual(raw);
      const reply = Uint8Array.from([0x44, 0x49, 0x44, 0x4c, 0, 1, 0x68, 1, raw.length, ...raw]);
      expect(decodeCandidReply(reply)).toEqual([raw]);
      expect(icpPrincipalBytes(icpPrincipalText(decodeCandidReply(reply)[0] as Uint8Array))).toEqual(raw);
      reply[7] = 0;
      expect(() => decodeCandidReply(reply)).toThrow(/principal marker/);
    },
  );

  it("round-trips the recorded NFT principal census and ledger identities", () => {
    for (const principal of [SWAP, LEDGER, ...SWAP_CONFIGS.map((config) => config.canisterId)]) {
      expect(icpPrincipalText(icpPrincipalBytes(principal))).toBe(principal);
    }
  });
});

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
    expect(result.metadata?.details?.querySignatureTimeSec).toBe(1_752_600_000);
    expect(result.metadata?.details?.querySignatureTimeVerification).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
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

  it.each(["identical", "conflicting"])("rejects %s duplicate canister configs before balance reads", async (kind) => {
    const hex = SWAP_CONFIG_REPLY.replyHex;
    const firstOffset = hex.indexOf("010004010a") + 6;
    const secondOffset = hex.indexOf("010a0000000001c045c60101");
    const first = hex.slice(firstOffset, secondOffset);
    const repeated = kind === "identical" ? first : first.replace("00e40b5402000000", "00e8764817000000");
    const reply = Buffer.from(hex.slice(0, firstOffset - 2) + "02" + first + repeated, "hex");
    let balanceReads = 0;
    mockFetch([
      { match: `https://icrc-api.internetcomputer.org/api/v1/ledgers/${LEDGER}`,
        respond: () => jsonResponse({ icrc1_metadata: { icrc1_total_supply: SUPPLY.toString() } }) },
      { match: (request) => new URL(request.url).pathname.endsWith("/query"),
        respond: (request) => {
          if (!request.url.includes(`/canister/${SWAP}/`)) balanceReads++;
          return icpReplyFixtureResponse(reply);
        } },
    ], { requireMatch: true });
    const { coin, config } = resolveAdapterCoin("icp-gldt", "gldt-gold-dao");
    await expect(fetchIcpGldtReserves(coin, config, new AbortController().signal)).rejects.toThrow(/duplicate NFT canister/);
    expect(balanceReads).toBe(0);
  });

  it("rejects a signed-negative NFT balance through the real query transport", async () => {
    mockFetch([
      { match: `https://icrc-api.internetcomputer.org/api/v1/ledgers/${LEDGER}`,
        respond: () => jsonResponse({ icrc1_metadata: { icrc1_total_supply: SUPPLY.toString() } }) },
      { match: (request) => new URL(request.url).pathname.endsWith("/query"),
        respond: (request) => icpReplyFixtureResponse(Uint8Array.from(Buffer.from(
          request.url.includes(`/canister/${SWAP}/`) ? SWAP_CONFIG_REPLY.replyHex : "4449444c016d77010001ff",
          "hex",
        ))) },
    ], { requireMatch: true });
    const { coin, config } = resolveAdapterCoin("icp-gldt", "gldt-gold-dao");
    await expect(fetchIcpGldtReserves(coin, config, new AbortController().signal)).rejects.toThrow(/is negative/);
  });

  it.each([
    ["81a16974696d657374616d701b18527c6a11598000", 1_752_600_000_000_000_000n],
    ["80", null], ["81a16974696d657374616d7063626164", null],
    ["81a16974696d657374616d703b0000000000000000", null],
    ["81a0", null], ["f6", null],
  ])("keeps query-signature evidence diagnostic-only (%s)", async (signatureHex, expectedTime) => {
    const envelope = Buffer.from(
      "a366737461747573677265706c696564657265706c79a16361726741446a7369676e617475726573" + signatureHex,
      "hex",
    );
    mockFetch([{ match: (request) => new URL(request.url).pathname.endsWith("/query"),
      respond: () => new Response(envelope) }], { requireMatch: true });
    const query = await queryIcpCanister({
      canisterId: SWAP, methodName: "get_swap_configs", arg: new Uint8Array(), signal: new AbortController().signal,
    });
    expect(query).toEqual({ reply: Uint8Array.of(0x44), querySignatureTimeNanos: expectedTime, rejectMessage: null });
    const metadata = adaptIcpGldtState(state({ querySignatureTimeNanos: query.querySignatureTimeNanos }), PARAMS).metadata;
    expect(metadata?.freshnessMode).toBe("not-applicable");
    expect(metadata?.sourceTimestamp).toBeUndefined();
    expect(metadata?.totalReserveQuantity).toBe(5945);
    expect(Object.keys(metadata?.details ?? {}).some((key) => key.startsWith("certified"))).toBe(false);
    expect(metadata?.details?.querySignatureTimeVerification).toBe(expectedTime === null ? undefined : "unverified");
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
