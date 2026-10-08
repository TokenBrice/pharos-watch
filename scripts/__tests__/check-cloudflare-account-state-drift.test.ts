import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compareCloudflareAccountState,
  fetchCloudflareAccountState,
  loadCloudflareAccountStateManifest,
  runCloudflareAccountStateDriftCheck,
} from "../ci/check-cloudflare-account-state-drift.mjs";
import { mockConsole } from "../test-utils/ci-script-test-helpers";

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
  heavyWorker: {
    exists: boolean;
    sharedDatabase: boolean;
    workflowBinding: boolean;
    publicWorkflowBinding: boolean;
    workflowAbsent: boolean;
    workersDev: boolean;
    previewUrls: boolean;
    routes: string[];
  };
}

function readFixture(name: string): FixtureLiveState {
  return {
    ...JSON.parse(readFileSync(resolve(process.cwd(), "scripts/__tests__/fixtures/cloudflare-account-state", name), "utf8")),
    heavyWorker: {
      exists: true, sharedDatabase: true, workflowBinding: false, publicWorkflowBinding: false,
      workflowAbsent: true, workersDev: false, previewUrls: false, routes: [],
    },
  } as FixtureLiveState;
}

function createFixtureFetch(
  liveState: FixtureLiveState,
  override?: (path: string, result: unknown) => Response | undefined,
) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const account = "/client/v4/accounts/account-id-not-in-manifest";
    const project = `${account}/pages/projects/${liveState.pages.project.name}`;
    const ruleset = "/client/v4/zones/zone-id-not-in-manifest/rulesets/phases/http_ratelimit/entrypoint";
    const heavy = liveState.heavyWorker;
    const databaseId = "8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a";
    const extra: Record<string, unknown> = {
      [`${account}/workers/scripts/stablecoin-api/settings`]: { bindings: [
        { type: "d1", name: "DB", id: databaseId },
        ...(heavy.publicWorkflowBinding ? [{ type: "workflow", name: "SAFETY_SCORE_V9_WORKFLOW", workflow_name: "safety-score-v9-publication" }] : []),
      ] },
      [`${account}/workers/scripts/stablecoin-heavy/settings`]: { bindings: [
        { type: "d1", name: "DB", id: heavy.sharedDatabase ? databaseId : "wrong-database" },
        ...(heavy.workflowBinding ? [{ type: "workflow", name: "SAFETY_SCORE_V9_WORKFLOW", workflow_name: "safety-score-v9-publication" }] : []),
        { type: "secret_text", name: "COINGECKO_API_KEY", text: "heavy-secret-sentinel" },
      ] },
      [`${account}/workers/scripts/stablecoin-heavy/subdomain`]: { enabled: heavy.workersDev, previews_enabled: heavy.previewUrls },
      [`${account}/workflows/safety-score-v9-publication`]: {
        name: "safety-score-v9-publication", script_name: "stablecoin-heavy", class_name: "SafetyScoreV9PublicationWorkflow",
      },
      ["/client/v4/zones/zone-id-not-in-manifest/workers/routes"]: heavy.routes.map((pattern) => ({ script: "stablecoin-heavy", pattern })),
    };
    if (Object.hasOwn(extra, url.pathname)) {
      if (!heavy.exists && url.pathname.endsWith("/stablecoin-heavy/settings")) return new Response("missing", { status: 404 });
      const result = extra[url.pathname];
      const overridden = override?.(url.pathname, result);
      if (overridden) return overridden;
      if (heavy.workflowAbsent && url.pathname.endsWith("/workflows/safety-score-v9-publication")) {
        return Response.json({ success: false, errors: [{ code: 1, message: "Workflow not found" }] }, { status: 404 });
      }
      return Response.json({ success: true, result });
    }
    if (!["/client/v4/zones", project, `${project}/domains`, `${account}/access/apps`, `${account}/workers/domains`, ruleset].includes(url.pathname)) {
      throw new Error(`Unexpected fixture URL: ${url}`);
    }
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
    const result = url.pathname === "/client/v4/zones"
      ? [
          {
            id: "zone-id-not-in-manifest",
            name: liveState.zone.name,
            status: liveState.zone.status,
            account: { id: "account-id-not-in-manifest" },
          },
        ]
      : url.pathname === `${account}/workers/domains`
        ? liveState.workerDomains
        : url.pathname === `${project}/domains`
          ? liveState.pages.customDomains.map((name) => ({ name }))
          : url.pathname === `${account}/access/apps`
          ? liveState.accessApplications.map((application) => ({
              type: application.type,
              self_hosted_domains: application.selfHostedDomains,
              session_duration: application.sessionDuration,
            }))
            : url.pathname === ruleset
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
    return override?.(url.pathname, result) ?? new Response(JSON.stringify({ success: true, result }), { status: 200 });
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
      ]),
    );
  });

  it.each([
    ["exists", false], ["sharedDatabase", false], ["workflowBinding", true],
    ["publicWorkflowBinding", true], ["workflowAbsent", false],
    ["workersDev", true], ["previewUrls", true], ["routes", ["pharos.watch/heavy/*"]],
  ] as const)("detects heavy %s drift from real GET response shapes", async (field, value) => {
    const fixture = readFixture("healthy-live-state.json");
    Object.assign(fixture.heavyWorker, { [field]: value });
    const state = await fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: createFixtureFetch(fixture) });
    expect(compareCloudflareAccountState(manifest, state).some((entry: string) => entry.startsWith(`heavyWorker.${field}:`))).toBe(true);
  });

  it("rejects heavy custom domains and public retention of the moved Workflow binding", async () => {
    const fixture = readFixture("healthy-live-state.json");
    fixture.workerDomains.push({ hostname: "heavy.pharos.watch", service: "stablecoin-heavy" });
    const fetchMock = createFixtureFetch(fixture, (path, result) => {
      if (!path.endsWith("/stablecoin-api/settings")) return;
      const settings = result as { bindings: unknown[] };
      settings.bindings.push({ type: "workflow", name: "SAFETY_SCORE_V9_WORKFLOW", workflow_name: "safety-score-v9-publication" });
      return Response.json({ success: true, result: settings });
    });
    const state = await fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock });
    expect(compareCloudflareAccountState(manifest, state)).toEqual(expect.arrayContaining([
      "heavyWorker.customDomains: expected none", "heavyWorker.publicWorkflowBinding: expected false, found true",
    ]));
  });

  it("never treats an unreadable route list as proof of no heavy routes", async () => {
    const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"), (path) =>
      path.endsWith("/workers/routes") ? Response.json({ success: true, result: {} }) : undefined);
    await expect(fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock }))
      .rejects.toThrow("malformed route list");
  });

  it("treats an existing unbound named Workflow as drift", async () => {
    const fixture = readFixture("healthy-live-state.json");
    fixture.heavyWorker.workflowAbsent = false;
    const state = await fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: createFixtureFetch(fixture) });
    expect(state.heavyWorker.workflowBinding).toBe(false);
    expect(state.heavyWorker.publicWorkflowBinding).toBe(false);
    expect(compareCloudflareAccountState(manifest, state)).toContain("heavyWorker.workflowAbsent: expected true, found false");
  });

  it.each([
    [404, "not JSON"],
    [404, JSON.stringify({ success: false, errors: [] })],
    [404, JSON.stringify({ success: false, errors: [{ code: 1, message: "Unauthorized" }] })],
    [403, JSON.stringify({ success: false, errors: [{ code: 1, message: "Workflow not found" }] })],
    [200, JSON.stringify({ success: true, result: null })],
    [200, JSON.stringify({ success: true, result: {} })],
    [200, JSON.stringify({ success: true, result: { name: "other", script_name: "worker", class_name: "Class" } })],
  ])("does not interpret unreadable Workflow response %s as absence", async (status, body) => {
    const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"), (path) =>
      path.endsWith("/workflows/safety-score-v9-publication") ? new Response(body, { status }) : undefined);
    await expect(fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock }))
      .rejects.toThrow("Cloudflare Workflow lookup");
  });

  it("fetches live state with GET only and removes account IDs and secret values before comparison", async () => {
    const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"));
    const liveState = await fetchCloudflareAccountState({
      manifest,
      apiToken: "test-token-that-must-not-be-reported",
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(compareCloudflareAccountState(manifest, liveState)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(fetchMock.mock.calls.some(([request]) =>
      new URL(String(request)).pathname.endsWith("/workflows/safety-score-v9-publication"))).toBe(true);
    for (const [request, init] of fetchMock.mock.calls) {
      expect(new URL(String(request)).pathname).toContain("/client/v4/");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token-that-must-not-be-reported");
    }
    expect(JSON.stringify(liveState)).not.toContain("account-id-not-in-manifest");
    expect(JSON.stringify(liveState)).not.toContain("secret-value-that-must-not-be-reported");
    expect(JSON.stringify(liveState)).not.toContain("heavy-secret-sentinel");
  });

  it("prefers unified bindings, deduplicates resource names, and discards secret text", async () => {
    const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"), (path, result) => {
      if (!path.endsWith(`/pages/projects/${manifest.pages.project}`)) return;
      const project = result as { deployment_configs: { production: Record<string, unknown> } };
      Object.assign(project.deployment_configs.production, {
        env_vars: { COLLISION: { type: "plain_text", value: "legacy" } },
        d1_databases: { DB: {} },
        kv_namespaces: { CACHE: {} },
        bindings: [
          { name: "COLLISION", type: "plain_text", text: "unified" },
          { name: "SECRET", type: "secret_text", text: "unified-secret-sentinel" },
          { name: "DB", type: "d1" }, { name: "DB", type: "d1" }, { name: "EXTRA_DB", type: "d1" },
          { name: "CACHE", type: "kv_namespace" }, { name: "CACHE", type: "kv_namespace" },
        ],
      });
      return new Response(JSON.stringify({ success: true, result }));
    });
    const state = await fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock });
    expect(state.pages.project.production).toEqual({
      environmentVariables: { COLLISION: { type: "plain_text", value: "unified" }, SECRET: { type: "secret_text" } },
      d1Bindings: ["DB", "EXTRA_DB"],
      kvBindings: ["CACHE"],
    });
    expect(JSON.stringify(state)).not.toContain("unified-secret-sentinel");
  });

  it("rejects zero or multiple exact zones before fetching account resources", async () => {
    for (const count of [0, 2]) {
      const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"), (path, result) => {
        if (path !== "/client/v4/zones") return;
        const [zone] = result as unknown[];
        return new Response(JSON.stringify({ success: true, result: Array(count).fill(zone) }));
      });
      await expect(fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock }))
        .rejects.toThrow(`returned ${count} exact active matches`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("allows a missing optional ruleset but rejects project HTTP, API, and JSON failures", async () => {
    const optional = createFixtureFetch(readFixture("healthy-live-state.json"), (path) =>
      path.includes("/rulesets/") ? new Response("missing", { status: 404 }) : undefined);
    const state = await fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: optional });
    expect(state.rateLimitRules).toEqual([]);
    for (const [body, status, error] of [
      [JSON.stringify({ success: false }), 404, "failed (HTTP 404)"],
      [JSON.stringify({ success: false }), 200, "failed (HTTP 200)"],
      ["not JSON", 200, "returned an unparseable response (HTTP 200)"],
    ] as const) {
      const fetchMock = createFixtureFetch(readFixture("healthy-live-state.json"), (path) =>
        path.endsWith(`/pages/projects/${manifest.pages.project}`) ? new Response(body, { status }) : undefined);
      await expect(fetchCloudflareAccountState({ manifest, apiToken: "token", fetchImpl: fetchMock }))
        .rejects.toThrow(`Cloudflare Pages project lookup ${error}`);
    }
  });

  it.each(["healthy", "drifted"])("reports %s orchestration without leaking credentials", async (kind) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const report = await runCloudflareAccountStateDriftCheck({
      manifest,
      env: { CLOUDFLARE_ACCOUNT_STATE_DRIFT_API_TOKEN: "token-secret-sentinel", NODE_ENV: "test" },
      fetchImpl: createFixtureFetch(readFixture(`${kind}-live-state.json`)),
      consoleImpl: mockConsole({ log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) }),
    });
    expect(report.ok).toBe(kind === "healthy");
    if (kind === "healthy") {
      expect(report.drift).toEqual([]);
      expect(errors).toEqual([]);
      expect(logs).toHaveLength(1);
    } else {
      expect(report.drift).toContain('pages.customDomains: missing "ops.pharos.watch"');
      expect(errors).toContain('  - pages.customDomains: missing "ops.pharos.watch"');
      expect(logs).toEqual([]);
    }
    const output = JSON.stringify({ report, logs, errors });
    expect(output).not.toContain("token-secret-sentinel");
    expect(output).not.toContain("secret-value-that-must-not-be-reported");
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
