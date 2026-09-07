import { formatSchemaLikeIssues } from "@shared/lib/schema-like";
import { logWorkerEventArgs } from "./structured-log";
import type { ZodType } from "zod";

export function validatePayloadWithSchema<T>(
  schema: ZodType<T>,
  payload: unknown,
  context: string,
): { ok: true; data: T } | { ok: false; issues: string } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = formatSchemaLikeIssues(parsed.error.issues);
  logWorkerEventArgs("lib", "error", `[validate] ${context} schema validation failed: ${issues}`);
  return { ok: false, issues };
}
