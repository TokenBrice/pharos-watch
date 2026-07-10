import { SchemaValidationError, apiRequest } from "@/lib/api";
import { z, type ZodType } from "zod";
import {
  isMiniAppErrorCode,
  MiniAppRequestError,
  type MiniAppErrorCode,
} from "./error-messages";
import type { TelegramMiniAppState } from "./types";

const TelegramAlertTypesSchema = z.object({
  dews: z.boolean(),
  depeg: z.boolean(),
  safety: z.boolean(),
  launch: z.boolean(),
  reserve: z.boolean(),
}).passthrough();

const PresetAlertTypesSchema = z.object({
  dews: z.boolean(),
  depeg: z.boolean(),
  safety: z.boolean(),
}).passthrough();

const TelegramDepegStepBpsSchema = z.union([z.literal(100), z.literal(250), z.literal(500)]);

export const TelegramMiniAppStateSchema: ZodType<TelegramMiniAppState> = z.object({
  viewer: z.object({
    userId: z.string(),
    username: z.string().nullable(),
    firstName: z.string().nullable().optional(),
    chatId: z.string().nullable(),
    chatType: z.string().nullable(),
    startParam: z.string().nullable().optional(),
    canMutate: z.boolean(),
    mutationBlockReason: z.enum(["not-private", "stale-auth"]).nullable(),
  }).passthrough(),
  subscriber: z.object({
    exists: z.boolean(),
    globalAlerts: TelegramAlertTypesSchema.extend({
      depegStepBps: TelegramDepegStepBpsSchema.nullable(),
    }).passthrough(),
    quietHours: z.object({
      enabled: z.boolean(),
      startHourUtc: z.number().nullable(),
      endHourUtc: z.number().nullable(),
      timezone: z.string().nullable(),
    }).passthrough(),
    snoozeUntilTs: z.number().nullable(),
  }).passthrough(),
  presets: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    alertTypes: PresetAlertTypesSchema,
    depegStepBps: TelegramDepegStepBpsSchema.nullable(),
  }).passthrough()),
  subscriptions: z.array(z.object({
    stablecoinId: z.string(),
    symbol: z.string(),
    name: z.string(),
    alertTypes: TelegramAlertTypesSchema,
    alertOverrides: TelegramAlertTypesSchema.optional(),
    dewsMinBand: z.enum(["ALERT", "WARNING", "DANGER"]).nullable(),
    depegStepBps: TelegramDepegStepBpsSchema.nullable(),
    safetyMode: z.enum(["all", "downgrade-only", "upgrade-only"]).nullable(),
    snoozeUntilTs: z.number().nullable(),
  }).passthrough()),
  catalog: z.object({
    recommendedPresets: z.array(z.object({
      id: z.string(),
      label: z.string(),
      description: z.string().nullable().optional(),
    }).passthrough()),
    searchableCoins: z.array(z.object({
      stablecoinId: z.string(),
      symbol: z.string(),
      name: z.string(),
      peg: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
    }).passthrough()),
  }).passthrough(),
  health: z.object({
    lastSuccessfulDeliveryAt: z.number().nullable(),
    lastSuccessfulReplyAt: z.number().nullable(),
    queuedAlerts: z.number(),
    recentFailureClass: z.string().nullable(),
  }).passthrough(),
}).passthrough();

function formatZodIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join(", ");
}

export async function postMiniAppJson<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  const response = await apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code: MiniAppErrorCode | null = null;
    try {
      const payload = await response.json() as { code?: unknown };
      if (isMiniAppErrorCode(payload?.code)) code = payload.code;
    } catch {
      // body wasn't JSON or was empty - leave code null
    }
    throw new MiniAppRequestError(response.status, code);
  }

  const payload: unknown = await response.json();
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new SchemaValidationError(path, formatZodIssues(result.error.issues));
  }
  return result.data;
}
