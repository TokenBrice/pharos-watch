import { z } from "zod";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveInput,
} from "../types/live-reserve-core";

export * from "./live-reserve-adapter-param-schemas";

export type LiveReserveInputKind = LiveReserveInput["kind"];

const AbsoluteUrlSchema = z.string().url();
const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveSemanticsSchema = z.enum(LIVE_RESERVE_SEMANTICS_VALUES);

const LiveReserveDisplaySchema = z
  .object({
    url: AbsoluteUrlSchema.optional(),
    label: z.string().optional(),
  })
  .strict();

const liveReserveScoringPolicySchema = z
  .object({
    maxSourceAgeSec: z.number().positive().optional(),
    allowedDegradedWarningCodes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const LiveReserveInputSchemaByKind = {
  "http-json": z
    .object({
      kind: z.literal("http-json"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  "http-html": z
    .object({
      kind: z.literal("http-html"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  indexer: z
    .object({
      kind: z.literal("indexer"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  "onchain-solana": z
    .object({
      kind: z.literal("onchain-solana"),
    })
    .strict(),
  "onchain-evm": z
    .object({
      kind: z.literal("onchain-evm"),
      chain: z.string(),
      rpcMode: LiveReserveRpcModeSchema,
    })
    .strict(),
} as const satisfies Record<LiveReserveInputKind, z.ZodTypeAny>;

export function createLiveReserveInputSchemaForKinds(kinds: readonly LiveReserveInputKind[]): z.ZodTypeAny {
  const schemas = kinds.map((kind) => LiveReserveInputSchemaByKind[kind]);
  if (schemas.length === 1) return schemas[0];
  // Zod unions require a non-empty tuple that TypeScript cannot infer from map().
  return z.union(schemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

export const baseLiveReserveConfigSchema = z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().min(1).optional(),
  display: LiveReserveDisplaySchema.optional(),
  scoring: liveReserveScoringPolicySchema.optional(),
});
