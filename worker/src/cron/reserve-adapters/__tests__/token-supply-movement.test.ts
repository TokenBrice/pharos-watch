import { describe, expect, it } from "vitest";
import { fetchMovementFungibleAssetSupply } from "../token-supply";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

const MOVEMENT_BASE = "https://mainnet.movementnetwork.xyz/v1";
const METADATA_ADDRESS =
  "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e";
const LEDGER_VERSION = "199722477";
const SUPPLY_URL = `${MOVEMENT_BASE}/accounts/${METADATA_ADDRESS}/resource/0x1::fungible_asset::ConcurrentSupply?ledger_version=${LEDGER_VERSION}`;
const METADATA_URL = `${MOVEMENT_BASE}/accounts/${METADATA_ADDRESS}/resource/0x1::fungible_asset::Metadata?ledger_version=${LEDGER_VERSION}`;

describe("fetchMovementFungibleAssetSupply", () => {
  it("pins supply and coin-resource decimals to the same ledger", async () => {
    const network = installAdapterNetwork({
      json: {
        [MOVEMENT_BASE]: { ledger_version: LEDGER_VERSION },
        [SUPPLY_URL]: {
          type: "0x1::fungible_asset::ConcurrentSupply",
          data: { current: { value: "1739632096715" } },
        },
        [METADATA_URL]: {
          type: "0x1::fungible_asset::Metadata",
          data: { decimals: 6 },
        },
      },
    });

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toEqual({
      rawSupply: 1_739_632_096_715n,
      decimals: 6,
      ledgerVersion: LEDGER_VERSION,
    });

    expect(network.requests.slice(1).every(
      ({ url }) => url.endsWith(`?ledger_version=${LEDGER_VERSION}`),
    )).toBe(true);
  });

  it("returns unresolved when the provider omits its ledger", async () => {
    installAdapterNetwork({ json: { [MOVEMENT_BASE]: {} } });

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toBeNull();
  });

  it("returns unresolved for malformed supply instead of converting it to zero", async () => {
    installAdapterNetwork({
      json: {
        [MOVEMENT_BASE]: { ledger_version: LEDGER_VERSION },
        [SUPPLY_URL]: {
          type: "0x1::fungible_asset::ConcurrentSupply",
          data: { current: {} },
        },
        [METADATA_URL]: {
          type: "0x1::fungible_asset::Metadata",
          data: { decimals: 6 },
        },
      },
    });

    await expect(fetchMovementFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
    )).resolves.toBeNull();
  });
});
