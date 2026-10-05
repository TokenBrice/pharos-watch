import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../request", () => ({
  fetchJsonPostWithRetry: vi.fn(),
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../request";
import { fetchStarknetTotalSupply } from "../starknet";
import { fetchIcrcLedgerTotalSupply } from "../icp";
import { fetchMoveFungibleAssetSupply, fetchTonJettonSupply } from "../token-supply";

const STARKNET_CONTRACT = "0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc";
const ICP_CANISTER = "6c7su-kiaaa-aaaar-qaira-cai";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("fetchStarknetTotalSupply", () => {
  beforeEach(() => {
    vi.mocked(fetchJsonPostWithRetry).mockReset();
  });

  it("recombines the u256 low/high felt pair", async () => {
    vi.mocked(fetchJsonPostWithRetry).mockResolvedValue({ result: ["0x25336d2a5e3a4976ecf5", "0x0"] });

    await expect(fetchStarknetTotalSupply({ contract: STARKNET_CONTRACT, signal: signal() }))
      .resolves.toBe(175_676_210_017_239_649_676_533n);

    const [url, body] = vi.mocked(fetchJsonPostWithRetry).mock.calls[0] ?? [];
    expect(url).toBe("https://api.cartridge.gg/x/starknet/mainnet");
    expect(body).toMatchObject({
      method: "starknet_call",
      params: { request: { contract_address: STARKNET_CONTRACT, calldata: [] }, block_id: "latest" },
    });
  });

  it("carries the high felt into the recombined value", async () => {
    vi.mocked(fetchJsonPostWithRetry).mockResolvedValue({ result: ["0x2", "0x1"] });

    await expect(fetchStarknetTotalSupply({ contract: STARKNET_CONTRACT, signal: signal() }))
      .resolves.toBe((1n << 128n) + 2n);
  });

  it("falls through to the next endpoint on an RPC error and prefers configured endpoints", async () => {
    vi.mocked(fetchJsonPostWithRetry)
      .mockResolvedValueOnce({ error: { message: "Contract not found" } })
      .mockResolvedValueOnce({ result: ["0xa", "0x0"] });

    await expect(fetchStarknetTotalSupply({
      contract: STARKNET_CONTRACT,
      signal: signal(),
      rpcUrl: "https://starknet.example",
    })).resolves.toBe(10n);

    expect(vi.mocked(fetchJsonPostWithRetry).mock.calls[0]?.[0]).toBe("https://starknet.example");
    expect(vi.mocked(fetchJsonPostWithRetry).mock.calls[1]?.[0]).toBe("https://api.cartridge.gg/x/starknet/mainnet");
  });

  it("fails closed when every endpoint fails", async () => {
    vi.mocked(fetchJsonPostWithRetry).mockRejectedValue(new Error("network down"));

    await expect(fetchStarknetTotalSupply({ contract: STARKNET_CONTRACT, signal: signal() }))
      .rejects.toThrow("network down");
  });

  it("rejects a non-felt contract address", async () => {
    await expect(fetchStarknetTotalSupply({ contract: "not-a-felt", signal: signal() }))
      .rejects.toThrow("felt contract address");
    expect(fetchJsonPostWithRetry).not.toHaveBeenCalled();
  });
});

describe("fetchIcrcLedgerTotalSupply", () => {
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
  });

  it("reads icrc1_total_supply in base units", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      icrc1_metadata: { icrc1_symbol: "GLDT", icrc1_decimals: "8", icrc1_total_supply: "59450000000000" },
    });

    await expect(fetchIcrcLedgerTotalSupply({ canisterId: ICP_CANISTER, signal: signal() }))
      .resolves.toBe(59_450_000_000_000n);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[0]?.[0])
      .toBe(`https://icrc-api.internetcomputer.org/api/v1/ledgers/${ICP_CANISTER}`);
  });

  it("fails closed when the ledger response omits the supply", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({ icrc1_metadata: {} });

    await expect(fetchIcrcLedgerTotalSupply({ canisterId: ICP_CANISTER, signal: signal() }))
      .rejects.toThrow("icrc1_total_supply missing");
  });

  it("rejects a canister id that is not a text-form principal", async () => {
    await expect(fetchIcrcLedgerTotalSupply({ canisterId: "../../etc/passwd", signal: signal() }))
      .rejects.toThrow("text-form canister id");
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
  });
});

describe("pinned Move fungible-asset census reads", () => {
  const base = "https://move.example/v1";
  const packageAddress = `0x${"a".repeat(64)}`;
  const metadataAddress = `0x${"b".repeat(64)}`;
  const clock = 1791146773;
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
  });

  it("finds a complete historical block from a near-head bracket and pins both resources", async () => {
    vi.mocked(fetchJsonWithRetry).mockImplementation(async (url) => {
      if (url === base) return { chain_id: 1, ledger_version: "100", ledger_timestamp: String((clock + 1) * 1_000_000) };
      if (url.includes("/blocks/by_version/100?")) return {
        first_version: "99", last_version: "100", block_timestamp: String((clock + 1) * 1_000_000),
      };
      if (url.includes("/blocks/by_version/98?")) return {
        first_version: "97", last_version: "98", block_timestamp: String(clock * 1_000_000),
      };
      if (url.includes("ConcurrentSupply")) return { type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "0" } } };
      if (url.includes("Metadata")) return { type: "0x1::fungible_asset::Metadata", data: { decimals: 6 } };
      throw new Error("unexpected request");
    });
    expect(await fetchMoveFungibleAssetSupply(metadataAddress, signal(), base, undefined, { clockSec: clock, expectedChainId: 1 }))
      .toEqual({ rawSupply: 0n, decimals: 6, ledgerVersion: "98", ledgerTimestampSec: clock });
    expect(vi.mocked(fetchJsonWithRetry).mock.calls.slice(-2).every(([url]) => url.endsWith("?ledger_version=98"))).toBe(true);
  });

  it("authenticates the deployed OFT package metadata and all mint/burn/transfer refs at the same ledger", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ chain_id: 126, ledger_version: "100", ledger_timestamp: String(clock * 1_000_000) })
      .mockResolvedValueOnce({ type: `${packageAddress}::oft_fa::OftImpl`, data: {
        metadata: { inner: metadataAddress },
        mint_ref: { metadata: { inner: metadataAddress } },
        burn_ref: { metadata: { inner: metadataAddress } },
        transfer_ref: { metadata: { inner: metadataAddress } },
      } })
      .mockResolvedValueOnce({ type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "123" } } })
      .mockResolvedValueOnce({ type: "0x1::fungible_asset::Metadata", data: { decimals: 6 } });
    expect(await fetchMoveFungibleAssetSupply(packageAddress, signal(), base, undefined, {
      clockSec: clock, expectedChainId: 126, identityKind: "oft-package",
    })).toEqual({ rawSupply: 123n, decimals: 6, ledgerVersion: "100", ledgerTimestampSec: clock });
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[1]?.[0])
      .toBe(`${base}/accounts/${packageAddress}/resource/${packageAddress}::oft_fa::OftImpl?ledger_version=100`);
    expect(vi.mocked(fetchJsonWithRetry).mock.calls[2]?.[0])
      .toBe(`${base}/accounts/${metadataAddress}/resource/0x1::fungible_asset::ConcurrentSupply?ledger_version=100`);
  });

  it.each(["wrong-type", "wrong-ref", "missing-ref"])("rejects unauthenticated OFT metadata: %s", async failure => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ chain_id: 1, ledger_version: "100", ledger_timestamp: String(clock * 1_000_000) })
      .mockResolvedValueOnce({ type: failure === "wrong-type" ? "foreign::oft_fa::OftImpl" : `${packageAddress}::oft_fa::OftImpl`, data: {
        metadata: { inner: metadataAddress },
        mint_ref: { metadata: { inner: metadataAddress } },
        burn_ref: failure === "missing-ref" ? undefined : { metadata: { inner: failure === "wrong-ref" ? packageAddress : metadataAddress } },
        transfer_ref: { metadata: { inner: metadataAddress } },
      } });
    expect(await fetchMoveFungibleAssetSupply(packageAddress, signal(), base, undefined, {
      clockSec: clock, expectedChainId: 1, identityKind: "oft-package",
    })).toBeNull();
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(2);
  });

  it.each([
    { chain_id: 126, ledger_version: "100", ledger_timestamp: String(clock * 1_000_000) },
    { chain_id: 1, ledger_version: "100" },
    { chain_id: 1, ledger_version: "1.5", ledger_timestamp: String(clock * 1_000_000) },
  ])("rejects missing timestamp, invalid ledger or wrong chain %j", async ledger => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce(ledger);
    expect(await fetchMoveFungibleAssetSupply(metadataAddress, signal(), base, undefined, {
      clockSec: clock, expectedChainId: 1,
    })).toBeNull();
    expect(fetchJsonWithRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong identity", "wrong decimals", "exact bigint"])("binds economic metadata and decimals: %s", async failure => {
    const amount = "123456789012345678901234567890123456";
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ chain_id: 1, ledger_version: "100", ledger_timestamp: String(clock * 1_000_000) })
      .mockResolvedValueOnce({ type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: amount } } })
      .mockResolvedValueOnce({ type: "0x1::fungible_asset::Metadata", data: { decimals: failure === "wrong decimals" ? 18 : 6 } })
      .mockResolvedValueOnce({ type: "0x1::object::ObjectCore", data: { transfer_events: {
        guid: { id: { addr: failure === "wrong identity" ? packageAddress : metadataAddress } },
      } } });
    const result = await fetchMoveFungibleAssetSupply(metadataAddress, signal(), base, undefined, {
      clockSec: clock, expectedChainId: 1, expectedMetadataAddress: metadataAddress, expectedDecimals: 6,
    });
    if (failure !== "exact bigint") expect(result).toBeNull();
    else {
      expect(result).toMatchObject({ rawSupply: BigInt(amount), metadataAddress, ledgerVersion: "100", ledgerTimestampSec: clock, decimals: 6 });
      expect(result?.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects a package resolving to a different reviewed metadata object", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ chain_id: 1, ledger_version: "100", ledger_timestamp: String(clock * 1_000_000) })
      .mockResolvedValueOnce({ type: `${packageAddress}::oft_fa::OftImpl`, data: {
        metadata: { inner: metadataAddress },
        ...Object.fromEntries(["mint_ref", "burn_ref", "transfer_ref"].map(name => [name, { metadata: { inner: metadataAddress } }])),
      } });
    expect(await fetchMoveFungibleAssetSupply(packageAddress, signal(), base, undefined, {
      clockSec: clock, expectedChainId: 1, identityKind: "oft-package", expectedMetadataAddress: packageAddress, expectedDecimals: 6,
    })).toBeNull();
  });
});

describe("pinned TON jetton supply", () => {
  const master = "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr";
  const base = "https://ton.example/api/v2", clock = 1791187343;
  const pin = { workchain: -1, shard: "-9223372036854775808", seqno: 97048839,
    root_hash: "G++xuEKh8vIc5zIdqmuZXGKyAKbwCiAqzTKEsTSI3OM=", file_hash: "VsEwupusnpifJYRlFR4f9cZ1vJqpnxb9Huywp8jBA90=" };
  const amount = 123456789012345678901234567890123456n;
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
    vi.mocked(fetchJsonPostWithRetry).mockReset();
  });
  function mockTon(failure?: string) {
    vi.mocked(fetchJsonWithRetry).mockImplementation(async url => {
      if (url.includes("/getMasterchainInfo")) return { ok: true, result: { last: failure === "missing pin" ? undefined : pin } };
      if (url.includes("/lookupBlock")) return { ok: true, result: failure === "missing pin" ? undefined : pin };
      if (url.includes("/getBlockHeader")) return { ok: true, result: { id: pin, global_id: -239, gen_utime: failure === "missing timestamp" ? undefined : clock } };
    });
    vi.mocked(fetchJsonPostWithRetry).mockImplementation(async url => {
      if (url.endsWith("/getTokenData")) return { ok: true, result: { address: failure === "wrong identity" ? "other-master" : master, contract_type: "jetton_master",
        total_supply: failure === "supply mismatch" ? "1" : amount.toString(),
        jetton_content: { type: "onchain", data: { decimals: failure === "decimals mismatch" ? "9" : failure === "missing decimals" ? undefined : "6" } } } };
      return { ok: true, result: { exit_code: failure === "failed method" ? 11 : 0,
        block_id: failure === "missing getter pin" ? undefined : failure === "wrong getter pin" ? { ...pin, seqno: pin.seqno + 1 } : pin,
        stack: [["num", `0x${amount.toString(16)}`]] } };
    });
  }
  it("reads exact BigInt supply, onchain decimals and the true pinned masterchain clock", async () => {
    mockTon();
    const result = await fetchTonJettonSupply(master, signal(), base, { clockSec: clock, expectedDecimals: 6 });
    expect(result).toMatchObject({ rawSupply: amount, decimals: 6, masterchainSeqno: pin.seqno, blockHash: pin.root_hash, blockTimestampSec: clock });
    expect(result?.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(vi.mocked(fetchJsonPostWithRetry).mock.calls[0]?.[1]).toEqual({ address: master, method: "get_jetton_data", stack: [], seqno: pin.seqno });
    expect(vi.mocked(fetchJsonPostWithRetry).mock.calls[1]?.[1]).toEqual({ address: master, seqno: pin.seqno });
  });
  it.each(["wrong identity", "missing pin", "missing timestamp", "missing getter pin", "wrong getter pin", "decimals mismatch", "missing decimals", "supply mismatch", "failed method"])
    ("fails closed on %s", async failure => {
      mockTon(failure);
      expect(await fetchTonJettonSupply(master, signal(), base, { clockSec: clock, expectedDecimals: 6 })).toBeNull();
    });
  it.each(["changed", "missing"])("rejects a %s header after the state read", async failure => {
    mockTon();
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({ ok: true, result: { last: pin } })
      .mockResolvedValueOnce({ ok: true, result: { id: pin, global_id: -239, gen_utime: clock } })
      .mockResolvedValueOnce({ ok: true, result: failure === "missing" ? undefined : { id: pin, global_id: -239, gen_utime: clock - 1 } });
    expect(await fetchTonJettonSupply(master, signal(), base, { clockSec: clock, expectedDecimals: 6 })).toBeNull();
  });
  it("uses the predecessor if time lookup lands one block after the scoring clock", async () => {
    mockTon();
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({ ok: true, result: { last: { ...pin, seqno: pin.seqno + 1 } } })
      .mockResolvedValueOnce({ ok: true, result: { id: { ...pin, seqno: pin.seqno + 1 }, global_id: -239, gen_utime: clock + 1 } })
      .mockResolvedValueOnce({ ok: true, result: { ...pin, seqno: pin.seqno + 1 } })
      .mockResolvedValueOnce({ ok: true, result: { id: { ...pin, seqno: pin.seqno + 1 }, global_id: -239, gen_utime: clock + 1 } });
    expect(await fetchTonJettonSupply(master, signal(), base, { clockSec: clock, expectedDecimals: 6 }))
      .toMatchObject({ masterchainSeqno: pin.seqno, blockTimestampSec: clock });
  });
});
