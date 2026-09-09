import { z } from "zod";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveAdapterValidationPolicy,
  type LiveReserveInput,
} from "../types/live-reserve-core";
import { MATERIAL_UNKNOWN_EXPOSURE_PCT } from "../types/live-reserve-adapter-policy";
import {
  type LiveReserveAdapterKey,
  type LiveReservesConfig,
} from "../types/live-reserves";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
} from "./live-reserve-adapter-descriptors";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";

export * from "../types/live-reserve-adapter-policy";

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
  const inputSchema = createLiveReserveInputSchemaForKinds(LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].primaryInputKinds);
  return z.object({ primary: inputSchema, fallbacks: z.array(inputSchema).optional() }).strict();
}

export type LiveReserveAdapterParamsByKey = {
  [K in LiveReserveAdapterKey]: z.infer<(typeof LIVE_RESERVE_ADAPTER_DEFINITIONS)[K]["params"]>;
};

function validateAdapterConfigPolicy(
  adapterKey: LiveReserveAdapterKey,
  config: Pick<LiveReservesConfig, "semantics" | "version" | "scoring">,
  ctx: z.RefinementCtx,
): void {
  const policy = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].configValidation;
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
  const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
  const adapterCap = "validation" in definition && "maxSourceAgeSec" in definition.validation
    ? definition.validation.maxSourceAgeSec
    : undefined;
  const coinCap = config.scoring?.maxSourceAgeSec;
  if (coinCap != null && adapterCap != null && coinCap > adapterCap) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scoring", "maxSourceAgeSec"],
      message: `${adapterKey} source-age override may only tighten the adapter cap (${adapterCap}s)`,
    });
  }
}

const liveReserveConfigAdapterKeys = Object.keys(LIVE_RESERVE_ADAPTER_DEFINITIONS) as LiveReserveAdapterKey[];
const liveReserveConfigVariants = liveReserveConfigAdapterKeys.map((adapterKey) => {
  const paramsSchema = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].params;
  return baseLiveReserveConfigSchema.extend({
    adapter: z.literal(adapterKey),
    inputs: createLiveReserveInputsSchema(adapterKey),
    // A params block is only optional when the adapter's own schema accepts
    // `{}`; otherwise omitting it must fail config validation, not first in prod.
    params: paramsSchema.safeParse({}).success ? paramsSchema.optional() : paramsSchema,
  }).superRefine((config, ctx) => validateAdapterConfigPolicy(adapterKey, config, ctx));
}) as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]];

export const LiveReservesConfigSchema: z.ZodType<LiveReservesConfig> = z.union(
  liveReserveConfigVariants as unknown as [z.ZodType<LiveReservesConfig>, ...z.ZodType<LiveReservesConfig>[]],
);


export {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LIVE_RESERVE_ADAPTER_STATUS_VALUES,
};
export { baseLiveReserveConfigSchema };

export type { LiveReserveAdapterDefinitionMap } from "./live-reserve-adapter-descriptors";

export function getLiveReserveAdapterDefinition(
  adapterKey: string,
): (typeof LIVE_RESERVE_ADAPTER_DEFINITIONS)[LiveReserveAdapterKey] | null {
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey as LiveReserveAdapterKey] ?? null;
}

/**
 * The adapter's declared validation policy, or `undefined` when the adapter
 * declares none. Callers that need an effective bound must apply their own
 * default; this returns exactly what the declaration states.
 */
export function getLiveReserveAdapterValidationPolicy(
  adapterKey: LiveReserveAdapterKey,
): LiveReserveAdapterValidationPolicy | undefined {
  const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
  return "validation" in definition ? definition.validation : undefined;
}

/**
 * Effective unknown-exposure ceiling: the adapter's declared cap when it states
 * one, otherwise the shared materiality threshold every basket adapter is held
 * to. Use this instead of re-deriving the fallback per adapter.
 */
export function getLiveReserveAdapterMaxUnknownExposurePct(
  adapterKey: LiveReserveAdapterKey,
): number {
  return getLiveReserveAdapterValidationPolicy(adapterKey)?.maxUnknownExposurePct ?? MATERIAL_UNKNOWN_EXPOSURE_PCT;
}

export function parseLiveReserveAdapterParams<K extends LiveReserveAdapterKey>(
  adapterKey: K,
  params: Record<string, unknown> | undefined,
): LiveReserveAdapterParamsByKey[K] {
  // Zod indexed access loses the per-key type; cast aligns the schema with the keyed params type
  const schema = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].params as unknown as z.ZodType<LiveReserveAdapterParamsByKey[K]>;
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
  throw new Error(`${adapterKey} adapter params invalid${path}: ${issue?.message ?? "unknown validation error"}`);
}

/** Bind retained evidence to the exact adapter inputs, independently of display/scoring policy. */
export function computeLiveReserveConfigFingerprint(config: LiveReservesConfig): string {
  return sha256Hex(stableJsonStringifyV1({
    adapter: config.adapter,
    version: config.version,
    semantics: config.semantics,
    inputs: config.inputs,
    params: config.params ?? {},
  }));
}
