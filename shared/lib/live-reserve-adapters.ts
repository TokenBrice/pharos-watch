import { z } from "zod";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveInput,
} from "../types/live-reserve-core";
import {
  type LiveReserveAdapterKey,
  type LiveReservesConfig,
} from "../types/live-reserves";
import {
  adapterParamsSchemas,
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
} from "./live-reserve-adapter-descriptors";

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
  "http-json": z.object({ kind: z.literal("http-json"), url: AbsoluteUrlSchema }).strict(),
  "http-html": z.object({ kind: z.literal("http-html"), url: AbsoluteUrlSchema }).strict(),
  indexer: z.object({ kind: z.literal("indexer"), url: AbsoluteUrlSchema }).strict(),
  "onchain-solana": z.object({ kind: z.literal("onchain-solana") }).strict(),
  "onchain-evm": z
    .object({
      kind: z.literal("onchain-evm"),
      chain: z.string(),
      rpcMode: LiveReserveRpcModeSchema,
    })
    .strict(),
} as const satisfies Record<LiveReserveInputKind, z.ZodTypeAny>;

function createLiveReserveInputSchemaForKinds(kinds: readonly LiveReserveInputKind[]): z.ZodTypeAny {
  const schemas = kinds.map((kind) => LiveReserveInputSchemaByKind[kind]);
  if (schemas.length === 1) return schemas[0];
  return z.union(schemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

const baseLiveReserveConfigSchema = z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().min(1).optional(),
  display: LiveReserveDisplaySchema.optional(),
  scoring: liveReserveScoringPolicySchema.optional(),
  suspended: z
    .object({
      reason: z.string().min(1),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be an ISO date (YYYY-MM-DD)"),
      reviewBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "reviewBy must be an ISO date (YYYY-MM-DD)").optional(),
    })
    .strict()
    .optional(),
});

export function createLiveReserveInputsSchema(adapterKey: LiveReserveAdapterKey): z.ZodTypeAny {
  const inputSchema = createLiveReserveInputSchemaForKinds(LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[adapterKey]);
  return z.object({ primary: inputSchema, fallbacks: z.array(inputSchema).optional() }).strict();
}

export type LiveReserveAdapterParamsByKey = {
  [K in LiveReserveAdapterKey]: z.infer<(typeof adapterParamsSchemas)[K]>;
};

function validateAdapterConfigPolicy(
  adapterKey: LiveReserveAdapterKey,
  config: Pick<LiveReservesConfig, "semantics" | "version">,
  ctx: z.RefinementCtx,
): void {
  const policy = LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey].configValidation;
  const allowedSemantics = policy.allowedSemantics as readonly LiveReservesConfig["semantics"][];
  const allowedVersions = policy.allowedVersions as readonly number[];

  if (!allowedSemantics.includes(config.semantics)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["semantics"],
      message: `${adapterKey} adapter does not support semantics "${config.semantics}"`,
    });
  }
  if (!allowedVersions.includes(config.version)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["version"],
      message: `${adapterKey} adapter does not support config version ${config.version}`,
    });
  }
}

const liveReserveConfigAdapterKeys = Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTORS) as LiveReserveAdapterKey[];
const liveReserveConfigVariants = liveReserveConfigAdapterKeys.map((adapterKey) =>
  baseLiveReserveConfigSchema.extend({
    adapter: z.literal(adapterKey),
    inputs: createLiveReserveInputsSchema(adapterKey),
    params: adapterParamsSchemas[adapterKey].optional(),
  }).superRefine((config, ctx) => validateAdapterConfigPolicy(adapterKey, config, ctx)),
) as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]];

export const LiveReservesConfigSchema: z.ZodType<LiveReservesConfig> = z.union(
  liveReserveConfigVariants as unknown as [z.ZodType<LiveReservesConfig>, ...z.ZodType<LiveReservesConfig>[]],
);


export {
  adapterParamsSchemas,
  LIVE_RESERVE_ADAPTER_DESCRIPTORS,
  LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
};
export { baseLiveReserveConfigSchema };
export { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "./live-reserve-adapter-descriptors";

export type { LiveReserveAdapterDescriptorMap } from "./live-reserve-adapter-descriptors";

export function getLiveReserveAdapterDefinition(
  adapterKey: string,
): (typeof LIVE_RESERVE_ADAPTER_DESCRIPTORS)[LiveReserveAdapterKey] | null {
  return LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey as LiveReserveAdapterKey] ?? null;
}

export function parseLiveReserveAdapterParams<K extends LiveReserveAdapterKey>(
  adapterKey: K,
  params: Record<string, unknown> | undefined,
): LiveReserveAdapterParamsByKey[K] {
  // Zod indexed access loses the per-key type; cast aligns the schema with the keyed params type
  const schema = adapterParamsSchemas[adapterKey] as unknown as z.ZodType<LiveReserveAdapterParamsByKey[K]>;
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
  throw new Error(`${adapterKey} adapter params invalid${path}: ${issue?.message ?? "unknown validation error"}`);
}
