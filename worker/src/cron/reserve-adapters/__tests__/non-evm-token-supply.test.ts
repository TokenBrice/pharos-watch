import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../request", () => ({
  fetchJsonPostWithRetry: vi.fn(),
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../request";
import { fetchStarknetTotalSupply } from "../starknet";
import { fetchIcrcLedgerTotalSupply } from "../icp";

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
    expect(url).toBe("https://rpc.starknet.lava.build");
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
    expect(vi.mocked(fetchJsonPostWithRetry).mock.calls[1]?.[0]).toBe("https://rpc.starknet.lava.build");
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
