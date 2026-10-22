import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReserveAdapterCoin } from "@shared/types/core";
import { base64ToBytes, bytesToBase64 } from "@shared/lib/base64";
import { computeLiveReserveConfigFingerprint, LiveReservesConfigSchema } from "@shared/lib/live-reserve-adapters";
import { programAddress, publicKeyBytes } from "../../dex-liquidity/solana/program-address";
import { decodeM0SolanaGlobal, fetchM0SolanaWrapperReserves } from "../m0-solana-wrapper";
import { readSolanaMint, scaledSolanaRawAmount, SOLANA_TOKEN_2022_PROGRAM } from "../solana";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";
import currentCapture from "./fixtures/m0-solana-local-2026-10-21.json";

const NOW = 1792543000;
const SLOT = 459400000;
const M = "mzerojk9tg56ebsrEAhfkyc9VgKjTW2zDqp6C5mhjzH";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PROFILES = [
  { id: "usdk-kast", program: "extaykYu5AQcDm3qZAbiDN3yp6skqn6Nssj7veUUGZw", mint: "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX", global: "AiiXk9Rztiv9E72Ying8byGzvxnVmyaeunysYEmvG1NU", vault: "EHNaRY1ZdtaoPVMqE3TW6pacACzEoU1e9V1ToLyavowN" },
  { id: "xo-exodus", program: "mexteGyWXgUR65XepNKtLJ2H66MmyLWrDSeA1bqzZ4C", mint: "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", vault: "GeBTfYujk4JLr2MBCZznMTLTGch1QrUyYcMKen4KUFU2" },
] as const;
interface Account { owner: string; executable: boolean; bytes: Uint8Array }

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function mint(supply: bigint, authority: string, multiplier?: number): Uint8Array {
  const data = new Uint8Array(multiplier === undefined ? 82 : 226);
  const view = dataView(data);
  view.setUint32(0, 1, true); data.set(publicKeyBytes(authority), 4);
  view.setBigUint64(36, supply, true); data[44] = 6; data[45] = 1;
  if (multiplier !== undefined) {
    data[165] = 1; view.setUint16(166, 25, true); view.setUint16(168, 56, true);
    view.setFloat64(202, multiplier, true); view.setBigInt64(210, 0n, true); view.setFloat64(218, multiplier, true);
  }
  return data;
}

async function fixture(profile: typeof PROFILES[number] = PROFILES[0]) {
  const encoder = new TextEncoder();
  const global = await programAddress(profile.program, [encoder.encode("global")]);
  const authority = await programAddress(profile.program, [encoder.encode("m_vault")]);
  const mintAuthority = await programAddress(profile.program, [encoder.encode("mint_authority")]);
  const programData = await programAddress(LOADER, [publicKeyBytes(profile.program)]);
  const vault = await programAddress(ATA, [publicKeyBytes(authority), publicKeyBytes(SOLANA_TOKEN_2022_PROGRAM), publicKeyBytes(M)]);
  const state = new Uint8Array(177); // None pending admin plus its reserved allocation
  state.set([116, 209, 219, 83, 70, 143, 55, 127]);
  state.set(publicKeyBytes(profile.mint), 41); state.set(publicKeyBytes(M), 73);
  const program = new Uint8Array(36); dataView(program).setUint32(0, 2, true); program.set(publicKeyBytes(programData), 4);
  const held = new Uint8Array(166); held.set(publicKeyBytes(M)); held.set(publicKeyBytes(authority), 32);
  dataView(held).setBigUint64(64, 100_000_000n, true); held[108] = 1; held[165] = 2;
  const accounts: Record<string, Account> = {
    [profile.program]: { owner: LOADER, executable: true, bytes: program },
    [global]: { owner: profile.program, executable: false, bytes: state },
    [profile.mint]: { owner: SOLANA_TOKEN_2022_PROGRAM, executable: false, bytes: mint(110_000_000n, mintAuthority, profile.id === "usdk-kast" ? 1 : undefined) },
    [M]: { owner: SOLANA_TOKEN_2022_PROGRAM, executable: false, bytes: mint(1_000_000_000n, mintAuthority, 1.1) },
    [vault]: { owner: SOLANA_TOKEN_2022_PROGRAM, executable: false, bytes: held },
  };
  const config = LiveReservesConfigSchema.parse({
    adapter: "m0-solana-wrapper", version: 1, semantics: "single-asset",
    display: { label: "M0 local wrapper", url: "https://docs.m0.org/protocol/solana" },
    inputs: { primary: { kind: "onchain-solana" } },
    params: { program: profile.program, globalAccount: global, wrapperMint: profile.mint, underlyingMint: M, underlyingVault: vault, assetLabel: "M held in the exact local extension vault" },
  });
  const coin = { id: profile.id, contracts: [{ chain: "solana", address: profile.mint, decimals: 6 }] } as ReserveAdapterCoin;
  let timestamp = NOW;
  const requests: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const rpc = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    requests.push(rpc);
    if (rpc.method === "getBlockTime") return Response.json({ result: timestamp });
    if (rpc.method !== "getMultipleAccounts") throw new Error("Unexpected RPC method");
    return Response.json({ result: { context: { slot: SLOT }, value: (rpc.params[0] as string[]).map((address) => {
      const account = accounts[address];
      return account ? { owner: account.owner, executable: account.executable, data: [bytesToBase64(account.bytes), "base64"] } : null;
    }) } });
  }));
  return { profile, config, coin, accounts, global, vault, requests, setTimestamp(value: number) { timestamp = value; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("M0 Solana local wrapper", () => {
  it.each(PROFILES)("binds $id mint, global, executable and scaled M custody to one finalized bank", async (profile) => {
    const f = await fixture(profile);
    expect(f.vault).toBe(profile.vault);
    if ("global" in profile) expect(f.global).toBe(profile.global);
    const result = await fetchM0SolanaWrapperReserves(f.coin, f.config, new AbortController().signal, { nowSec: NOW });
    expectValidAdapterOutput("m0-solana-wrapper", result);
    expect(result.slices).toEqual([expect.objectContaining({ pct: 100, coinId: "m-m0", depType: "wrapper", sourceKey: "m0-solana-wrapper:m-vault" })]);
    expect(result.metadata).toMatchObject({ observedBlock: { chain: "solana", number: SLOT, timestamp: NOW }, underlyingBalanceRaw: "100000000", indexedUnderlyingBalanceRaw: "110000000", totalSupplyRaw: "110000000", collateralizationRatio: 1 });
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(f.requests.map((r) => r.method)).toEqual(["getMultipleAccounts", "getBlockTime"]);
    expect(f.requests[0].params[1]).toEqual({ encoding: "base64", commitment: "finalized" });
    expect(computeLiveReserveConfigFingerprint(f.config)).not.toBe(computeLiveReserveConfigFingerprint({ ...f.config, params: { ...f.config.params, globalAccount: M } }));
  });

  it.each(["missing-global", "global-owner", "wrong-mint", "yield-variant", "mint-authority", "vault-owner", "vault-mint", "program-loader", "program-executable", "program-data", "zero-supply", "wrapper-scale"])("withholds the whole local observation for %s", async (failure) => {
    const f = await fixture();
    if (failure === "missing-global") delete f.accounts[f.global];
    if (failure === "global-owner") f.accounts[f.global].owner = M;
    if (failure === "wrong-mint") f.accounts[f.global].bytes.set(publicKeyBytes(M), 41);
    if (failure === "yield-variant") f.accounts[f.global].bytes[140] = 1;
    if (failure === "mint-authority") f.accounts[f.profile.mint].bytes.set(publicKeyBytes(M), 4);
    if (failure === "vault-owner") f.accounts[f.vault].bytes.set(publicKeyBytes(M), 32);
    if (failure === "vault-mint") f.accounts[f.vault].bytes.set(publicKeyBytes(f.profile.mint));
    if (failure === "program-loader") f.accounts[f.profile.program].owner = M;
    if (failure === "program-executable") f.accounts[f.profile.program].executable = false;
    if (failure === "program-data") f.accounts[f.profile.program].bytes.set(publicKeyBytes(M), 4);
    if (failure === "zero-supply") dataView(f.accounts[f.profile.mint].bytes).setBigUint64(36, 0n, true);
    if (failure === "wrapper-scale") dataView(f.accounts[f.profile.mint].bytes).setFloat64(218, 2, true);
    await expect(fetchM0SolanaWrapperReserves(f.coin, f.config, new AbortController().signal, { nowSec: NOW })).rejects.toThrow();
  });

  it.each(PROFILES)("replays the original atomic current $id capture without renewing its clock", async (profile) => {
    const f = await fixture(profile);
    const capturedAddresses = currentCapture.request.params[0] as string[];
    const captured = new Map(capturedAddresses.map((address, i) => [address, currentCapture.response.result.value[i]] as const));
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (rpc.method === "getBlockTime") return Response.json({ result: currentCapture.block.timestamp });
      if (rpc.method !== "getMultipleAccounts") throw new Error("Unexpected captured RPC method");
      return Response.json({ result: { context: currentCapture.response.result.context, value: (rpc.params[0] as string[]).map((address) => captured.get(address) ?? null) } });
    }));
    const result = await fetchM0SolanaWrapperReserves(f.coin, f.config, new AbortController().signal, { nowSec: currentCapture.block.timestamp });
    expectValidAdapterOutput("m0-solana-wrapper", result);
    expect(result.metadata?.observedBlock).toEqual({ chain: "solana", number: currentCapture.block.slot, timestamp: currentCapture.block.timestamp });
    expect(result.metadata?.totalSupplyRaw).toBe(profile.id === "usdk-kast" ? "23939622844939" : "14008669633239");
    expect(result.metadata?.indexedUnderlyingBalanceRaw).toBe(profile.id === "usdk-kast" ? "24441457026511" : "14009619525355");
    expect(Number(result.metadata?.collateralizationRatio)).toBeGreaterThanOrEqual(1);
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it.each([NOW + 1, NOW - 1801])("rejects unusable original bank time %s", async (timestamp) => {
    const f = await fixture(); f.setTimestamp(timestamp);
    await expect(fetchM0SolanaWrapperReserves(f.coin, f.config, new AbortController().signal, { nowSec: NOW })).rejects.toThrow("stale or future");
  });

  it("retains measured local shortfall instead of manufacturing full coverage", async () => {
    const f = await fixture(); dataView(f.accounts[f.vault].bytes).setBigUint64(64, 50_000_000n, true);
    const result = await fetchM0SolanaWrapperReserves(f.coin, f.config, new AbortController().signal, { nowSec: NOW });
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }));
  });

  it("decodes the actual USDK ExtGlobalV2 discriminator and pending-admin layout", () => {
    // FD38 finalized slot459393633, 2026-10-20T22:20:03Z; no program byte-equivalence claim.
    const data = base64ToBytes("dNHbU0aPN39890XGpUEUSnn/t/R/PsDdmSrTBEBeq/cFh0gz/mB43wFC/N1MvvPh4z5Uhf88CCpm1MXaepDofzTCG/k+zDqgRw2LdCchO/ADFK19dz5R7TFYVzzLyKo1GBuoFp5Uw3WCC4a+ZtEd25p5vA5jEQrrYO/gztHlLZeodBe8mvxikKKpbZe1Jvsnl0MG4sWRQ7nBsb6JZP1eoyqKZgv4kiIfdP3//wAEAAAAUTkks+Ak6heLrR7fPF0aF4UwYmbunQVYRF4B4t1rfUEiBS/7+9d7IabH4tEs9Bo8tWWBH/ub763Zfqd3u7WV8nz3RcalQRRKef+39H8+wN2ZKtMEQF6r9wWHSDP+YHjfhI3MukCLt9bNZReoZG9yHU+BVceFnS9LIH0+7+c54Fo=");
    expect(decodeM0SolanaGlobal(data)).toMatchObject({ wrapperMint: PROFILES[0].mint, underlyingMint: M, authorities: 4 });
  });

  it("selects scaled-UI amount at the original bank time and rejects malformed or unsafe accounting", () => {
    const bytes = mint(100n, M, 1.1); dataView(bytes).setBigInt64(210, BigInt(NOW + 1), true); dataView(bytes).setFloat64(218, 1.2, true);
    const account = { owner: SOLANA_TOKEN_2022_PROGRAM, data: bytes };
    expect(readSolanaMint(account, NOW).multiplier).toBe(1.1);
    expect(readSolanaMint(account, NOW + 1).multiplier).toBe(1.2);
    expect(scaledSolanaRawAmount(100n, 1.1)).toBe(110n);
    expect(() => scaledSolanaRawAmount(1n << 63n, 1.1)).toThrow("safely representable");
    dataView(bytes).setUint16(168, 57, true);
    expect(() => readSolanaMint(account, NOW)).toThrow("exceeds account");
  });
});
