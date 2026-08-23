import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchJsonWithRetryMock = vi.fn();

vi.mock("../request", () => ({
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
  fetchJsonPostWithRetry: vi.fn(),
}));

import { fetchMovementFungibleAssetSupply } from "../token-supply";

const METADATA_ADDRESS =
  "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e";

describe("fetchMovementFungibleAssetSupply", () => {
  beforeEach(() => fetchJsonWithRetryMock.mockReset());

  it("pins supply and coin-resource decimals to the same ledger", async () => {
    fetchJsonWithRetryMock
      .mockResolvedValueOnce({ ledger_version: "199722477" })
      .mockResolvedValueOnce({
        type: "0x1::fungible_asset::ConcurrentSupply",
        data: { current: { value: "1739632096715" } },
      })
      .mockResolvedValueOnce({
        type: "0x1::fungible_asset::Metadata",
        data: { decimals: 6 },
      });

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toEqual({
      rawSupply: 1_739_632_096_715n,
      decimals: 6,
      ledgerVersion: "199722477",
    });

    expect(fetchJsonWithRetryMock.mock.calls.slice(1).every(
      ([url]) => String(url).endsWith("?ledger_version=199722477"),
    )).toBe(true);
  });

  it("returns unresolved when the provider omits its ledger", async () => {
    fetchJsonWithRetryMock.mockResolvedValueOnce({});

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toBeNull();
    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("returns unresolved for malformed supply instead of converting it to zero", async () => {
    fetchJsonWithRetryMock
      .mockResolvedValueOnce({ ledger_version: "199722477" })
      .mockResolvedValueOnce({
        type: "0x1::fungible_asset::ConcurrentSupply",
        data: { current: {} },
      })
      .mockResolvedValueOnce({
        type: "0x1::fungible_asset::Metadata",
        data: { decimals: 6 },
      });

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toBeNull();
  });
});
