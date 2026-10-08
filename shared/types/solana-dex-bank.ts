import { z } from "zod";

const SolanaDexPublicKeySchema = /* @__PURE__ */ (() => z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/))();
export const SolanaDexShadowTargetSchema = /* @__PURE__ */ (() => z.object({
  chain: z.literal("solana"),
  profileId: z.enum(["orca-whirlpool-exact-v1", "raydium-clmm-exact-v1"]),
  poolAddress: SolanaDexPublicKeySchema,
  tokenMintIn: SolanaDexPublicKeySchema,
  tokenMintOut: SolanaDexPublicKeySchema,
}).refine((target) => target.tokenMintIn !== target.tokenMintOut, "Native direction mints must differ"))();
export type SolanaDexShadowTarget = z.output<typeof SolanaDexShadowTargetSchema>;

/** A final RPC bank receipt, not a complete executable frozen-bank proof. */
export const SolanaDexBankCaptureSchema = /* @__PURE__ */ (() => z.object({
  schemaVersion: z.literal("solana-dex-bank-v1"),
  chain: z.literal("solana"),
  profileId: z.enum(["orca-whirlpool-exact-v1", "raydium-clmm-exact-v1"]),
  poolAddress: SolanaDexPublicKeySchema,
  slot: z.number().int().positive().safe(),
  scoreEligible: z.literal(false),
  programClosureComplete: z.literal(false),
  independentExecution: z.literal(false),
  accounts: z.array(z.object({
    address: SolanaDexPublicKeySchema,
    account: z.object({
      owner: SolanaDexPublicKeySchema,
      dataBase64: z.string().max(21848).regex(/^[A-Za-z0-9+/]*={0,2}$/)
        .refine((value) => value.length % 4 === 0, "Base64 data must contain complete four-character groups"),
    }).nullable(),
  })).min(3).max(8),
}).refine((capture) => new Set(capture.accounts.map((entry) => entry.address)).size === capture.accounts.length, "Bank account addresses must be unique"))();
export type SolanaDexBankCapture = z.output<typeof SolanaDexBankCaptureSchema>;
export type SolanaDexBankCaptureSink = (capture: SolanaDexBankCapture) => void | Promise<void>;
