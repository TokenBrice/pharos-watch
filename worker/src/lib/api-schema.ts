import { logWorkerEventArgs } from "./structured-log";
import type { ZodIssue, ZodType } from "zod";

function formatSchemaIssues(issues: readonly ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join(", ");
}

export function validatePayloadWithSchema<T>(
  schema: ZodType<T>,
  payload: unknown,
  context: string,
): { ok: true; data: T } | { ok: false; issues: string } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = formatSchemaIssues(parsed.error.issues);
  logWorkerEventArgs("lib", "error", `[validate] ${context} schema validation failed: ${issues}`);
  return { ok: false, issues };
}
