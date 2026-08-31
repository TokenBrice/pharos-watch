import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchYearnYboldSource } from "../yield-sync/sources";

const YBOLD_VAULT = "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8";
const YSYBOLD_VAULT = "0x23346B04a7f55b8760E5860AA5A77383D63491cD";
const BOLD_TOKEN = "0x6440f144b7e50D6a8439336510312d2F54beB01D";

function ydaemonRoutes(overrides?: { ybold?: unknown; ysybold?: unknown }) {
  return [
    {
      match: `ydaemon.yearn.fi/1/vaults/${YSYBOLD_VAULT.toLowerCase()}`,
      body: overrides?.ysybold ?? {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0.07073882937691378 },
        info: { isRetired: false },
      },
    },
    {
      match: `ydaemon.yearn.fi/1/vaults/${YBOLD_VAULT.toLowerCase()}`,
      body: overrides?.ybold ?? {
        address: YBOLD_VAULT,
        token: { address: BOLD_TOKEN },
        tvl: { tvl: 5_783_996.57 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    },
  ];
}

describe("fetchYearnYboldSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("publishes the yBOLD vault TVL with the staked ysyBOLD net APR", async () => {
    mockYieldSourceRoutes(ydaemonRoutes());

    await expect(fetchYearnYboldSource()).resolves.toEqual(
      expect.objectContaining({
        currentApy: expect.closeTo(7.073882937691378, 10),
        apyBase: expect.closeTo(7.073882937691378, 10),
        apyReward: null,
        sourcePool: YBOLD_VAULT.toLowerCase(),
        sourceTvlUsd: 5_783_996.57,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "protocol-api:yearn:ybold",
        yieldSource: "Yearn yBOLD Stability Pool vault",
        yieldType: "lending-vault",
      }),
    );
  });

  it("fails closed when the staked vault no longer wraps the tracked yBOLD vault", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: "0x0000000000000000000000000000000000000001" },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0.07 },
        info: { isRetired: false },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });

  it("fails closed when the yBOLD vault no longer wraps BOLD", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ybold: {
        address: YBOLD_VAULT,
        token: { address: "0x0000000000000000000000000000000000000002" },
        tvl: { tvl: 5_783_996.57 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });

  it("returns null when Yearn retires the staked vault", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0.07 },
        info: { isRetired: true },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });

  it("returns null when Yearn reports no staked return", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });

  it("returns null when the yBOLD vault TVL is below the publication floor", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ybold: {
        address: YBOLD_VAULT,
        token: { address: BOLD_TOKEN },
        tvl: { tvl: 1_000 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });

  it("returns null when the reported APR exceeds the accepted envelope", async () => {
    mockYieldSourceRoutes(ydaemonRoutes({
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 2.5 },
        info: { isRetired: false },
      },
    }));

    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });
});
