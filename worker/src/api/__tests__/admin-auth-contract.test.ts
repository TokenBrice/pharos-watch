import { describe, expect, it, vi } from "vitest";
import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  ENDPOINT_DEFINITIONS,
  isMutatingAdminPath,
} from "@shared/lib/api-endpoints";
import { isMutatingAdminGetAllowed } from "@shared/lib/api-endpoints/validation";
import { route } from "../../router";
import type { FullRouteContext } from "../../routes/shared";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

const db = mockD1([
  {
    match: "INSERT INTO admin_action_audit",
    rows: [],
  },
]);
const execCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeRouteCtx(overrides: Partial<FullRouteContext> & { url: URL }): FullRouteContext {
  const defaultRequest = new Request(overrides.url.toString());
  return { db, execCtx, request: defaultRequest, trustedAdmin: false, ...overrides };
}

/** Synthetic placeholders that satisfy each dynamic admin pattern's parameter constraints. */
const DYNAMIC_ADMIN_PROBE_PATHS: Record<string, string> = {
  "api-key-update": "/api/api-keys/7/update",
  "api-key-deactivate": "/api/api-keys/7/deactivate",
  "api-key-rotate": "/api/api-keys/7/rotate",
  "api-key-request-reject": "/api/api-key-requests-admin/akr_abc12345/reject",
  "api-key-request-release-claim": "/api/api-key-requests-admin/akr_abc12345/release-claim",
};

interface AdminProbeCase {
  label: string;
  path: string;
  method: "GET" | "POST";
}

function buildStaticAdminCases(): AdminProbeCase[] {
  const cases: AdminProbeCase[] = [];
  for (const endpoint of ENDPOINT_DEFINITIONS) {
    if (!endpoint.adminRequired) continue;
    const path = endpoint.probePath ?? endpoint.path;
    for (const method of endpoint.methods) {
      if (method !== "GET" && method !== "POST") continue;
      // Skip method-restricted mutating-admin GETs — those would 405 (method validation),
      // not the auth check we're trying to assert.
      if (
        method === "GET"
        && isMutatingAdminPath(endpoint.path)
        && !isMutatingAdminGetAllowed(new URL(`https://api.pharos.watch${path}`))
      ) {
        continue;
      }
      cases.push({ label: `${method} ${endpoint.path}`, path, method });
    }
  }
  return cases;
}

function buildDynamicAdminCases(): AdminProbeCase[] {
  const cases: AdminProbeCase[] = [];
  for (const descriptor of DYNAMIC_ENDPOINT_DESCRIPTORS) {
    if (!descriptor.adminRequired) continue;
    const probePath = DYNAMIC_ADMIN_PROBE_PATHS[descriptor.key];
    if (!probePath) {
      throw new Error(`admin-auth-contract: missing probe path for dynamic admin descriptor "${descriptor.key}"`);
    }
    for (const method of descriptor.methods) {
      if (method !== "GET" && method !== "POST") continue;
      cases.push({ label: `${method} ${probePath} (dynamic:${descriptor.key})`, path: probePath, method });
    }
  }
  return cases;
}

const ADMIN_CASES: AdminProbeCase[] = [...buildStaticAdminCases(), ...buildDynamicAdminCases()];

describe("admin auth contract: every admin route fails closed without an admin signal", () => {
  it("enumerates at least one case per admin endpoint", () => {
    const staticAdminPaths = new Set(
      ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.adminRequired).map((endpoint) => endpoint.path),
    );
    const dynamicAdminKeys = new Set(
      DYNAMIC_ENDPOINT_DESCRIPTORS.filter((descriptor) => descriptor.adminRequired).map((descriptor) => descriptor.key),
    );
    expect(staticAdminPaths.size + dynamicAdminKeys.size).toBeGreaterThan(0);
    expect(ADMIN_CASES.length).toBeGreaterThanOrEqual(staticAdminPaths.size + dynamicAdminKeys.size);
  });

  it.each(ADMIN_CASES)(
    "returns 401 or 403 for $label without any admin credential",
    async ({ path, method }) => {
      const url = new URL(`https://api.pharos.watch${path}`);
      // No X-Pharos-Admin header, no Cf-Access-Jwt-Assertion header, no trustedAdmin.
      const request = new Request(url.toString(), { method });
      const response = await route(makeRouteCtx({ url, request }));
      expect(response, `expected the router to match ${method} ${path}`).not.toBeNull();
      expect(
        [401, 403],
        `expected auth-failure status for ${method} ${path}, got ${response!.status}`,
      ).toContain(response!.status);
    },
    15_000,
  );
});
