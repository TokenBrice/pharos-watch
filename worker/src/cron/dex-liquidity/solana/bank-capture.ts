import { SolanaDexBankCaptureSchema, type SolanaDexBankCapture, type SolanaDexBankCaptureSink } from "@shared/types/solana-dex-bank";
import type { SolanaAccount } from "../../reserve-adapters/solana";

/** Offline proof plumbing: no raw-byte copies or serialized graph on the scheduled path. */
export async function captureSolanaDexBank(input: {
  profileId: SolanaDexBankCapture["profileId"];
  poolAddress: string;
  slot: number;
  addresses: readonly string[];
  accounts: ReadonlyMap<string, SolanaAccount | null>;
  sink?: SolanaDexBankCaptureSink;
}): Promise<void> {
  if (!input.sink) return;
  await input.sink(SolanaDexBankCaptureSchema.parse({
    schemaVersion: "solana-dex-bank-v1", chain: "solana", profileId: input.profileId,
    poolAddress: input.poolAddress, slot: input.slot, scoreEligible: false,
    programClosureComplete: false, independentExecution: false,
    accounts: input.addresses.map((address) => {
      const account = input.accounts.get(address);
      if (account && account.data.length > 16 * 1024) throw new Error("solana-bank-account-payload-overflow");
      return { address, account: account ? { owner: account.owner, dataBase64: btoa(String.fromCharCode(...account.data)) } : null };
    }),
  }));
}
