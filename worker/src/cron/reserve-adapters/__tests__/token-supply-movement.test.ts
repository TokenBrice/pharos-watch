import { describe, expect, it } from "vitest";
import { fetchMoveFungibleAssetSupply } from "../token-supply";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

const MOVEMENT_BASE = "https://mainnet.movementnetwork.xyz/v1";
const METADATA_ADDRESS =
  "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e";
const LEDGER_VERSION = "199722477";
const SUPPLY_URL = `${MOVEMENT_BASE}/accounts/${METADATA_ADDRESS}/resource/0x1::fungible_asset::ConcurrentSupply?ledger_version=${LEDGER_VERSION}`;
const METADATA_URL = `${MOVEMENT_BASE}/accounts/${METADATA_ADDRESS}/resource/0x1::fungible_asset::Metadata?ledger_version=${LEDGER_VERSION}`;

describe("fetchMoveFungibleAssetSupply", () => {
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

    await expect(fetchMoveFungibleAssetSupply(
      METADATA_ADDRESS,
      new AbortController().signal,
      MOVEMENT_BASE,
    )).resolves.toBeNull();
  });
});
