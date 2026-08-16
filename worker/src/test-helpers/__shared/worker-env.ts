import type { Env } from "../../lib/env";
import { mockD1 } from "./mock-d1";

function createRateLimit(): RateLimit {
  return {
    limit: async () => ({ success: true }),
  };
}

/** Build a complete Worker environment with isolated, fail-closed test bindings. */
export function createWorkerEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: mockD1(),
    TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: createRateLimit(),
    TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: createRateLimit(),
    TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT: createRateLimit(),
    CF_VERSION_METADATA: {
      id: "test-worker-version",
      tag: "test",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    CORS_ORIGIN: "https://pharos.watch",
    ...overrides,
  };
}
