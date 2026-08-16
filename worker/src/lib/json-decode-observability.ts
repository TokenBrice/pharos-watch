import { logWorkerEventArgs } from "./structured-log";
interface JsonDecodeLogOptions {
  scope: "api" | "cron" | "lib";
  owner: string;
  context: string;
  reason: string;
  source?: string;
  updatedAt?: number | null;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

export function logMalformedJsonPath(options: JsonDecodeLogOptions, error?: unknown): void {
  const parts = [
    `[json-decode] scope=${options.scope}`,
    `owner=${options.owner}`,
    `context=${options.context}`,
    `reason=${options.reason}`,
  ];

  if (options.source) {
    parts.push(`source=${options.source}`);
  }
  if (options.updatedAt != null) {
    parts.push(`updatedAt=${options.updatedAt}`);
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value != null) {
      parts.push(`${key}=${String(value)}`);
    }
  }

  logWorkerEventArgs("lib", "warn", parts.join(" "), error);
}
