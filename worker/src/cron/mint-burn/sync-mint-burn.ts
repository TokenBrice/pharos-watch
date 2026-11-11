import type { SyncMintBurnStatus } from "../../lib/mint-burn-pipeline/types";
import { MintBurnRun, type SyncMintBurnOptions } from "./run";

export async function syncMintBurn(
  db: D1Database,
  alchemyApiKey: string | null,
  options: SyncMintBurnOptions = {},
): Promise<{ itemCount: number; metadata: string; status?: SyncMintBurnStatus; error?: string }> {
  return new MintBurnRun(db, alchemyApiKey, options).execute();
}
