import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../types";
import { createKoiosReader } from "../koios";
import { installAdapterNetwork, type AdapterNetwork } from "./reserve-adapter.test-support";

// Pinned Koios tip captured live from api.koios.rest on 2026-09-09.
const TIP = {
  hash: "499b2403106b31f32cfdb638fa6598bd573daabdcad6658ec84bbc2055bed75b",
  block_no: 13_919_726,
  block_time: 1_788_981_858,
};
const BASE = "https://koios.test/api/v1";
const ADDRESS = "addr1z8mcpc26j64fmhhd6sv5qj5mk9xqnfxgm6k8zmk7h2rlu4qm5kjdmrpmng059yellupyvwgay2v0lz6663swmds7hp0qhxg9gt";
const POLICY_ID = "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61";
const ASSET_NAME = "446a65644d6963726f555344";
const SIGNAL = new AbortController().signal;

function readerCtx(network: AdapterNetwork, nowSec = TIP.block_time + 30): AdapterContext {
  return {
    chainRpcs: network.chainRpcs,
    requestCache: new Map(),
    nowSec,
    abortSignal: SIGNAL,
  };
}

function utxo(index: number, overrides: Record<string, unknown> = {}) {
  return {
    tx_hash: `${index.toString(16).padStart(64, "0")}`,
    tx_index: 0,
    value: "1000000",
    block_height: TIP.block_no,
    block_time: TIP.block_time,
    ...overrides,
  };
}

function addressRow(overrides: Record<string, unknown> = {}) {
  return {
    address: ADDRESS,
    balance: "1000000",
    script_address: true,
    utxo_set: [utxo(0)],
    ...overrides,
  };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    policy_id: POLICY_ID,
    asset_name: ASSET_NAME,
    total_supply: "1000000",
    mint_cnt: 1,
    burn_cnt: 0,
    ...overrides,
  };
}

describe("createKoiosReader tip pinning", () => {
  it("parses the one-row tip array and stamps the pinned block on the context", async () => {
    const network = installAdapterNetwork({ json: { [`${BASE}/tip`]: [TIP] } });
    const ctx = readerCtx(network);
    const reader = await createKoiosReader(BASE, SIGNAL, ctx);

    expect(reader.tip).toEqual({
      hash: TIP.hash,
      blockNo: TIP.block_no,
      blockTimeSec: TIP.block_time,
    });
    expect(ctx.observedBlock).toEqual({
      chain: "cardano",
      number: TIP.block_no,
      timestamp: TIP.block_time,
    });
  });

  it("rejects a tip older than the twenty-minute freshness window", async () => {
    const network = installAdapterNetwork({
      json: { [`${BASE}/tip`]: [{ ...TIP, block_time: TIP.block_time - 1_300 }] },
    });
    await expect(createKoiosReader(BASE, SIGNAL, readerCtx(network))).rejects.toThrow(
      /stale or future-dated/,
    );
  });

  it("rejects a tip beyond the two-minute future skew", async () => {
    const network = installAdapterNetwork({
      json: { [`${BASE}/tip`]: [{ ...TIP, block_time: TIP.block_time + 200 }] },
    });
    await expect(createKoiosReader(BASE, SIGNAL, readerCtx(network))).rejects.toThrow(
      /stale or future-dated/,
    );
  });
});

describe("createKoiosReader read budget", () => {
  it("serves twelve bounded reads and fails the thirteenth", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow()],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    for (let i = 0; i < 12; i += 1) {
      await expect(reader.addressInfo([ADDRESS])).resolves.toHaveLength(1);
    }
    await expect(reader.addressInfo([ADDRESS])).rejects.toThrow(/read budget exceeded \(12 requests\)/);
  });
});

describe("createKoiosReader cap rejection", () => {
  it("rejects an address_info row with more than 500 UTxOs", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow({ utxo_set: Array.from({ length: 501 }, (_, i) => utxo(i)) })],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.addressInfo([ADDRESS])).rejects.toThrow(/500/);
  });

  it("rejects a UTxO carrying more than 100 assets", async () => {
    const assetList = Array.from({ length: 101 }, (_, i) => ({
      policy_id: POLICY_ID,
      asset_name: i.toString(16).padStart(2, "0"),
      quantity: "1",
    }));
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow({ utxo_set: [utxo(0, { asset_list: assetList })] })],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.addressInfo([ADDRESS])).rejects.toThrow(/100/);
  });

  it("rejects an asset_info request for more than 16 units", async () => {
    const network = installAdapterNetwork({ json: { [`${BASE}/tip`]: [TIP] } });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    const units = Array.from({ length: 17 }, () => [POLICY_ID, ASSET_NAME] as [string, string]);
    await expect(reader.assetInfo(units)).rejects.toThrow(/between 1 and 16/);
  });
});

describe("createKoiosReader echo validation", () => {
  it("rejects an address row for an address that was not requested", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow({ address: "addr1unrequested0000000000000000000000000000000000000000000000000000000000000000000000000000004" })],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.addressInfo([ADDRESS])).rejects.toThrow(/unrequested address/);
  });

  it("rejects duplicate address rows", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow(), addressRow()],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.addressInfo([ADDRESS])).rejects.toThrow(/duplicate rows/);
  });

  it("rejects an address response that omits a requested address", async () => {
    const other = `${ADDRESS.slice(0, -1)}0`;
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/address_info`]: [addressRow()],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.addressInfo([ADDRESS, other])).rejects.toThrow(/returned 1 of 2 requested addresses/);
  });

  it("rejects an asset row for a unit that was not requested", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/asset_info`]: [assetRow({ asset_name: "deadbeef" })],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.assetInfo([[POLICY_ID, ASSET_NAME]])).rejects.toThrow(/unrequested unit/);
  });

  it("rejects duplicate asset rows", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/asset_info`]: [assetRow(), assetRow()],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.assetInfo([[POLICY_ID, ASSET_NAME]])).rejects.toThrow(/duplicate rows/);
  });

  it("rejects an asset response that omits a requested unit", async () => {
    const network = installAdapterNetwork({
      json: {
        [`${BASE}/tip`]: [TIP],
        [`${BASE}/asset_info`]: [assetRow()],
      },
    });
    const reader = await createKoiosReader(BASE, SIGNAL, readerCtx(network));
    await expect(reader.assetInfo([[POLICY_ID, ASSET_NAME], [POLICY_ID, "5368656e4d6963726f555344"]]))
      .rejects.toThrow(/returned 1 of 2 requested units/);
  });
});
