import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { buildRedemptionBackstopEntry } from "../redemption-backstop/sources";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";
import {
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetworkSpec,
} from "../../cron/reserve-adapters/__tests__/reserve-adapter.test-support";

afterEach(() => vi.unstubAllGlobals());

const NOW = 1_780_000_000;

function addressArg(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function addressWord(address: string): `0x${string}` {
  return `0x${addressArg(address)}`;
}

const WM_SUPPLY_USD = 82_000_000;
const WRAPPER_TOTAL_SUPPLY_RAW = 80_000_000_000000n;
const WRAPPER_M_BALANCE_RAW = 81_000_000_000000n;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function balanceOf(owner: string): `0x${string}` {
  return `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

/**
 * The wM config requires the exact `m-m0` payout identity. Its only telemetry
 * producer, `m0-wrapper-underlying` in `wrapped-m-token` mode, reads the
 * wrapper's M balance and must name that payout; otherwise every fresh read is
 * discarded as `route-output-identity-unobserved`.
 */
describe("wm-m0 exact M output identity", () => {
  it("admits the wrapper's fresh M balance as live capacity after publishing the m-m0 output key", async () => {
    const { coin, config } = resolveAdapterCoin("m0-wrapper-underlying", "wm-m0");
    const params = config.params as {
      mode?: string;
      wrapperAddress?: string;
      expectedMTokenAddress?: string;
      rpcUrl?: string;
    };
    expect(params.mode).toBe("wrapped-m-token");
    expect(config.inputs.primary).toMatchObject({ kind: "onchain-evm", chain: "ethereum" });

    const wrapper = params.wrapperAddress!;
    const mToken = params.expectedMTokenAddress!;
    const network: AdapterNetworkSpec = {
      ...(params.rpcUrl ? { chains: { ethereum: params.rpcUrl } } : {}),
      rpc: {
        [`ethereum:${wrapper}:0xc3b6f939`]: addressWord(mToken),
        [`ethereum:${wrapper}:0x18160ddd`]: word(WRAPPER_TOTAL_SUPPLY_RAW),
        [`ethereum:${wrapper}:0x313ce567`]: word(6n),
        [`ethereum:${mToken}:${balanceOf(wrapper)}`]: word(WRAPPER_M_BALANCE_RAW),
        [`ethereum:${mToken}:0x313ce567`]: word(6n),
      },
    };

    const run = await runAdapter("m0-wrapper-underlying", coin, { network, nowSec: NOW });
    const entry = await buildRedemptionBackstopEntry(
      mockD1Strict([]),
      "wm-m0",
      getRedemptionBackstopConfig("wm-m0")!,
      WM_SUPPLY_USD,
      null,
      NOW,
      { reserveSnapshotMetadata: liveSnapshot("wm-m0", run.result.metadata ?? {}, { fetchedAt: NOW - 60 }) },
    );

    expect(entry).toMatchObject({
      immediateCapacityUsd: 81_000_000,
      capacityKind: "live-direct",
      resolutionState: "resolved",
    });
    expect(entry.capacityRejectionReason).toBeUndefined();

    const redemption = (run.result.metadata as { redemption?: Record<string, unknown> } | undefined)?.redemption;
    expect(redemption?.outputAssetKeys).toEqual(["m-m0"]);
  });
});
