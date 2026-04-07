import { jsonResponse, parseOptionalRequestJsonObject } from "./api-utils";
import { runAdminRoute } from "./route-wrappers";

export interface AdminJobContext<TBody extends Record<string, unknown> = Record<string, unknown>> {
  url: URL;
  request?: Request;
  trustedAdmin?: boolean;
  body: TBody;
  dryRun: boolean;
}

interface RunAdminJobOptions {
  endpoint?: string;
  url: URL;
  request?: Request;
  trustedAdmin?: boolean;
  parseBody?: boolean;
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === "true";
}

export async function runAdminJob<TBody extends Record<string, unknown> = Record<string, unknown>>(
  options: RunAdminJobOptions,
  handler: (context: AdminJobContext<TBody>) => Promise<Response>,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: options.endpoint ?? "admin-job",
      request: options.request,
      trustedAdmin: options.trustedAdmin,
    },
    async () => {
      const parsedBody = options.parseBody ? await parseOptionalRequestJsonObject(options.request) : {};
      if (parsedBody instanceof Response) {
        return parsedBody;
      }

      const body = parsedBody as TBody;
      return handler({
        url: options.url,
        request: options.request,
        trustedAdmin: options.trustedAdmin,
        body,
        dryRun: isTruthyFlag(body.dryRun) || options.url.searchParams.get("dry-run") === "true",
      });
    },
  );
}

export function readAdminStringParam(
  body: Record<string, unknown>,
  searchParams: URLSearchParams,
  key: string,
): string | null {
  const bodyValue = typeof body[key] === "string" ? body[key] as string : null;
  const value = bodyValue ?? searchParams.get(key);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readAdminIntegerParam(
  body: Record<string, unknown>,
  searchParams: URLSearchParams,
  key: string,
): number | null {
  const bodyValue = typeof body[key] === "number" ? Math.trunc(body[key] as number) : null;
  if (bodyValue != null) return bodyValue;
  const raw = searchParams.get(key);
  if (raw == null || raw.trim() === "") return null;
  if (!/^-?\d+$/.test(raw.trim())) return null;
  return Math.trunc(Number(raw));
}

export function buildAdminJobSummary<T extends Record<string, unknown>>(summary: T): T {
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => !(
      Array.isArray(value) && value.length === 0
    )),
  ) as T;
}

export function noAdminTargetsResponse(message = "No coins in this batch"): Response {
  return jsonResponse({ message });
}
