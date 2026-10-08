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

export const SOLANA_DEX_NATIVE_PROGRAM_IDS = {
  "orca-whirlpool-exact-v1": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "raydium-clmm-exact-v1": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
} as const;

export const SolanaDexNativeTargetSchema = /* @__PURE__ */ (() => SolanaDexShadowTargetSchema.and(z.object({
  targetId: z.string().min(1).max(512),
  stablecoinId: z.string().min(1).max(128),
})))();
export type SolanaDexNativeTarget = z.output<typeof SolanaDexNativeTargetSchema>;

const NativeReferenceSchema = /* @__PURE__ */ (() => z.string().min(1).max(640))();
export const SolanaDexNativePointSchema = /* @__PURE__ */ (() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("full-fill"),
    notionalUsd: z.number().finite().positive(),
    quotedAt: z.number().int().nonnegative(),
    slot: z.number().int().positive().safe(),
    amountInRaw: z.string().regex(/^[1-9][0-9]{0,77}$/),
    amountOutRaw: z.string().regex(/^[1-9][0-9]{0,77}$/),
    outputRef: NativeReferenceSchema,
  }),
  z.object({
    status: z.enum(["failed", "unavailable"]),
    notionalUsd: z.number().finite().positive(),
    quotedAt: z.number().int().nonnegative(),
    reason: z.string().min(1).max(240),
  }),
]))();
export type SolanaDexNativePoint = z.output<typeof SolanaDexNativePointSchema>;

/** Local-model output and final RPC bytes, explicitly not independent program execution. */
export const SolanaDexNativeQuoteSchema = /* @__PURE__ */ (() => z.object({
  target: SolanaDexNativeTargetSchema,
  scoreEligible: z.literal(false),
  bank: SolanaDexBankCaptureSchema.nullable(),
  bankRef: NativeReferenceSchema.nullable(),
  proofRef: NativeReferenceSchema.nullable(),
  programId: SolanaDexPublicKeySchema,
  arrayAddresses: z.array(SolanaDexPublicKeySchema).max(5),
  dependencyAddresses: z.array(SolanaDexPublicKeySchema).max(2),
  inputPriceUsd: z.number().finite().positive(),
  inputDecimals: z.number().int().min(0).max(18),
  points: z.array(SolanaDexNativePointSchema).min(1).max(5),
}).superRefine((quote, ctx) => {
  const bank = quote.bank;
  const present = new Map(bank?.accounts.map((entry) => [entry.address, entry.account]) ?? []);
  const full = quote.points.filter((point) => point.status === "full-fill");
  const pool = present.get(quote.target.poolAddress);
  const mints = [quote.target.tokenMintIn, quote.target.tokenMintOut].map((mint) => present.get(mint));
  const mintBytes = mints.map((mint) => mint ? atob(mint.dataBase64) : "");
  if (quote.programId !== SOLANA_DEX_NATIVE_PROGRAM_IDS[quote.target.profileId] ||
      new Set(quote.points.map((point) => point.notionalUsd)).size !== quote.points.length ||
      new Set(quote.arrayAddresses).size !== quote.arrayAddresses.length ||
      new Set([quote.target.poolAddress, quote.target.tokenMintIn, quote.target.tokenMintOut,
        ...quote.arrayAddresses, ...quote.dependencyAddresses]).size !== 3 + quote.arrayAddresses.length + quote.dependencyAddresses.length ||
      (bank && (bank.profileId !== quote.target.profileId || bank.poolAddress !== quote.target.poolAddress)) ||
      (full.length > 0 && (!bank || !quote.bankRef || !quote.proofRef || !pool ||
        pool.owner !== quote.programId || mints.some((mint) => !mint ||
          mint.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") ||
        mintBytes.some((bytes) => bytes.length !== 82 || bytes.charCodeAt(45) !== 1 || bytes.charCodeAt(44) > 18) ||
        mintBytes[0]?.charCodeAt(44) !== quote.inputDecimals ||
        quote.arrayAddresses.length === 0 ||
        quote.arrayAddresses.length > (quote.target.profileId === "raydium-clmm-exact-v1" ? 3 : 5) ||
        quote.dependencyAddresses.length !== (quote.target.profileId === "raydium-clmm-exact-v1" ? 2 : 0) ||
        quote.dependencyAddresses.some((address) => present.get(address)?.owner !== quote.programId) ||
        quote.arrayAddresses.some((address) => present.get(address)?.owner !== quote.programId) ||
        full.some((point) => point.slot !== bank.slot)))) {
    ctx.addIssue({ code: "custom", message: "native-bank-evidence-incompatible" });
  }
}))();
export type SolanaDexNativeQuote = z.output<typeof SolanaDexNativeQuoteSchema>;

export const SolanaDexNativeGenerationSchema = /* @__PURE__ */ (() => z.object({
  schemaVersion: z.literal("solana-dex-generation-v1"),
  generationId: z.string().min(1).max(128),
  profileId: z.enum(["orca-whirlpool-exact-v1", "raydium-clmm-exact-v1"]),
  sourceGenerationId: z.string().min(1).max(128).nullable(),
  startedAt: z.number().int().nonnegative(),
  publishedAt: z.number().int().nonnegative(),
  scoreEligible: z.literal(false),
  quotes: z.array(SolanaDexNativeQuoteSchema).max(4),
}).superRefine((generation, ctx) => {
  if (generation.publishedAt < generation.startedAt ||
      (generation.quotes.length > 0 && !generation.sourceGenerationId) ||
      new Set(generation.quotes.map((quote) => quote.target.targetId)).size !== generation.quotes.length ||
      generation.quotes.some((quote) => {
        const bankRef = `${generation.generationId}:${quote.target.targetId}:bank:${quote.bank?.slot}`;
        return quote.target.profileId !== generation.profileId ||
          quote.target.targetId !== ["solana-dex-target-v1", quote.target.profileId, quote.target.stablecoinId,
            quote.target.poolAddress, quote.target.tokenMintIn, quote.target.tokenMintOut].join("|") ||
          (quote.bank && (quote.bankRef !== bankRef || quote.proofRef !== `${bankRef}:local-model`)) ||
          quote.points.some((point) => point.quotedAt < generation.startedAt || point.quotedAt > generation.publishedAt ||
            (point.status === "full-fill" && point.outputRef !== `${bankRef}:quote:${point.notionalUsd}`));
      })) {
    ctx.addIssue({ code: "custom", message: "native-generation-incompatible" });
  }
}))();
export type SolanaDexNativeGeneration = z.output<typeof SolanaDexNativeGenerationSchema>;
