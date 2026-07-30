import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compareCloudflareAccountState,
  fetchCloudflareAccountState,
  loadCloudflareAccountStateManifest,
  runCloudflareAccountStateDriftCheck,
} from "../ci/check-cloudflare-account-state-drift.mjs";

interface FixtureEnvironmentVariable {
  type: string;
  value?: string;
}

interface FixtureRateLimitRule {
  description: string;
  enabled: boolean;
  action: string;
  expression: string;
  ratelimit: {
    characteristics: string[];
    requestsPerPeriod: number;
    period: number;
    mitigationTimeout: number;
  };
}

interface FixtureLiveState {
  zone: { name: string; status: string };
  pages: {
    project: {
      name: string;
      production: {
        environmentVariables: Record<string, FixtureEnvironmentVariable>;
        d1Bindings: string[];
        kvBindings: string[];
      };
    };
    customDomains: string[];
  };
  accessApplications: Array<{
    type: string;
    selfHostedDomains: string[];
    sessionDuration: string;
  }>;
  workerDomains: Array<{ hostname: string; service: string }>;
  rateLimitRules: FixtureRateLimitRule[];
}

function readFixture(name: string): FixtureLiveState {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "scripts/__tests__/fixtures/cloudflare-account-state", name), "utf8"),
  ) as FixtureLiveState;
}

function createFixtureFetch(liveState: FixtureLiveState) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const production = liveState.pages.project.production;
    const envVars = Object.fromEntries(
      Object.entries(production.environmentVariables).map(([name, variable]) => [
        name,
        {
          type: variable.type,
          ...(variable.type === "secret_text" ? { value: "secret-value-that-must-not-be-reported" } : {}),
          ...(variable.value ? { value: variable.value } : {}),
        },
      ]),
    );
    const result = url.pathname.endsWith("/zones")
      ? [
          {
            id: "zone-id-not-in-manifest",
            name: liveState.zone.name,
            status: liveState.zone.status,
            account: { id: "account-id-not-in-manifest" },
          },
        ]
      : url.pathname.endsWith("/workers/domains")
        ? liveState.workerDomains
        : url.pathname.endsWith("/domains")
          ? liveState.pages.customDomains.map((name) => ({ name }))
          : url.pathname.endsWith("/access/apps")
          ? liveState.accessApplications.map((application) => ({
              type: application.type,
              self_hosted_domains: application.selfHostedDomains,
              session_duration: application.sessionDuration,
            }))
            : url.pathname.endsWith("/rulesets/phases/http_ratelimit/entrypoint")
              ? {
                  rules: liveState.rateLimitRules.map((rule) => ({
                    description: rule.description,
                    enabled: rule.enabled,
                    action: rule.action,
                    expression: rule.expression,
                    ratelimit: {
                      characteristics: rule.ratelimit.characteristics,
                      requests_per_period: rule.ratelimit.requestsPerPeriod,
                      period: rule.ratelimit.period,
                      mitigation_timeout: rule.ratelimit.mitigationTimeout,
                    },
                  })),
                }
              : {
                  name: liveState.pages.project.name,
                  deployment_configs: {
                    production: {
                      env_vars: envVars,
                      d1_databases: Object.fromEntries(production.d1Bindings.map((binding) => [binding, { id: "d1-id" }])),
                      kv_namespaces: Object.fromEntries(production.kvBindings.map((binding) => [binding, { namespace_id: "kv-id" }])),
                    },
                  },
                };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  });
}

describe("Cloudflare account-state drift comparison", () => {
  const manifest = loadCloudflareAccountStateManifest();

  it("accepts the healthy normalized fixture", () => {
    expect(compareCloudflareAccountState(manifest, readFixture("healthy-live-state.json"))).toEqual([]);
  });

  it("reports fixture drift by resource and field without reporting values for secrets", () => {
    expect(compareCloudflareAccountState(manifest, readFixture("drifted-live-state.json"))).toEqual(
      expect.arrayContaining([
        'pages.customDomains: missing "ops.pharos.watch"',
        'pages.production.environmentVariables.SITE_API_ORIGIN.value: expected "https://site-api.pharos.watch", found "https://wrong.example"',
        'pages.production.environmentVariables.TELEGRAM_ADOPTION_IP_HASH_SECRET.type: expected "secret_text", found "plain_text"',
        'pages.production.kvBindings: missing "SELECTOR_SNAPSHOTS"',
        'pages.production.environmentVariables.CF_ACCESS_TEAM_DOMAIN.type: expected "secret_text", found "plain_text"',
        'accessApplications.operator-ui.sessionDuration: expected "12h", found "24h"',
        'workerCustomDomains.ops-api.pharos.watch.service: expected "stablecoin-api", found "other-service"',
        'rateLimitRules.api-rate-limit-ip.action: expected "block", found "managed_challenge"',
        "rateLimitOrdering: api-self-serve-key-intake-limit must be evaluated before api-rate-limit-ip",
      ]),
    );
  });

  it("fetches live state with GET only and removes account IDs and secret values before comparison", async () => {
    const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"));
    const liveState = await fetchCloudflareAccountState({
      manifest,
      apiToken: "test-token-that-must-not-be-reported",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(compareCloudflareAccountState(manifest, liveState)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [request, init] of fetchMock.mock.calls) {
      expect(new URL(String(request)).pathname).toContain("/client/v4/");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token-that-must-not-be-reported");
    }
    expect(JSON.stringify(liveState)).not.toContain("account-id-not-in-manifest");
    expect(JSON.stringify(liveState)).not.toContain("secret-value-that-must-not-be-reported");
  });

  it("fails clearly before a network call when the dedicated token is absent", async () => {
    const fetchMock = vi.fn();
    await expect(
      runCloudflareAccountStateDriftCheck({
        env: { NODE_ENV: "test" },
        fetchImpl: fetchMock as typeof fetch,
        manifest,
      }),
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN is required; configure the repository secret of the same name.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
