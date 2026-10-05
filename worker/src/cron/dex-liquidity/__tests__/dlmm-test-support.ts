import { z } from "zod";
import fixture from "./fixtures/meteora-dlmm-pinned.json";
import { decodeDlmmBinArray, decodeDlmmPair, dlmmBinArrayAddress, type DlmmSnapshot } from "../solana/dlmm-quote";
import type { SolanaAccount } from "../../reserve-adapters/solana";

const expectedQuote = z.union([
  z.object({ reason: z.string() }),
  z.object({ amountOut: z.string(), fee: z.string(), protocolFee: z.string(), binsFilled: z.number(), endBinId: z.number(), feeOnInput: z.boolean() }),
]);
export const dlmmCaptures = z.array(z.object({
  assetId: z.string(), poolAddress: z.string(), tokenMintIn: z.string(), timestamp: z.string(), slot: z.number(),
  accounts: z.record(z.string(), z.object({ owner: z.string(), executable: z.boolean(), data: z.tuple([z.string(), z.string()]) }).nullable()),
  quotes: z.array(z.object({ amountIn: z.string(), sdkReference: expectedQuote })),
})).parse(fixture.captures);
export type DlmmCapture = typeof dlmmCaptures[number];

export function capturedDlmmAccounts(capture: DlmmCapture): Map<string, SolanaAccount | null> {
  return new Map(Object.entries(capture.accounts).map(([address, account]) => [address,
    account ? { owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) } : null]));
}

export async function capturedDlmmSnapshot(capture: DlmmCapture): Promise<DlmmSnapshot> {
  const accounts = capturedDlmmAccounts(capture);
  const pool = decodeDlmmPair(accounts.get(capture.poolAddress)!.data, capture.slot);
  const first = Math.floor(pool.activeId / 70);
  const direction = capture.tokenMintIn === pool.tokenMintX ? -1 : 1;
  const binArrays: DlmmSnapshot["binArrays"][number][] = [];
  for (let i = 0; i < 4; i++) {
    const index = first + direction * i;
    const address = await dlmmBinArrayAddress(capture.poolAddress, index);
    const account = accounts.get(address);
    if (account === undefined) throw new Error("Missing fixture account receipt");
    binArrays.push({ index, array: account ? decodeDlmmBinArray(account.data, address, capture.poolAddress, capture.slot) : null });
  }
  return { slot: capture.slot, poolAddress: capture.poolAddress, pool, timestamp: BigInt(capture.timestamp), clockSlot: BigInt(capture.slot),
    mintDecimals: [accounts.get(pool.tokenMintX)!.data[44], accounts.get(pool.tokenMintY)!.data[44]], binArrays };
}
