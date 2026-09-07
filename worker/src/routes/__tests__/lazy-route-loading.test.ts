import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defineLazyStaticRoute, type FullRouteContext } from "../shared";

const ROUTE_MODULES = [
  "../admin-routes.ts",
  "../dynamic-routes.ts",
  "../messaging-routes.ts",
  "../ops-routes.ts",
  "../public-routes.ts",
] as const;

const HTTP_ROOT_MODULES = [
  "../../router.ts",
  "../../handlers/http/gates.ts",
  "../../handlers/http/telegram-ingress-abuse.ts",
  "../../lib/api-key-core.ts",
  "../../lib/auth.ts",
  "../../lib/idempotency.ts",
  "../../lib/route-wrappers.ts",
] as const;

function readSource(relativePath: string): string {
  // The caller only supplies fixed source paths declared above.
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url).href), "utf8");
}

describe("lazy route loading", () => {
  it("does not load a static endpoint module until the route is invoked", async () => {
    const response = new Response("ok");
    const handler = vi.fn(async () => response);
    const loadHandler = vi.fn(async () => handler);
    const route = defineLazyStaticRoute("health", loadHandler);

    expect(loadHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    await expect(route.handler({} as FullRouteContext)).resolves.toBe(response);
    expect(loadHandler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps route catalogs free of runtime API imports", () => {
    for (const modulePath of ROUTE_MODULES) {
      const source = readSource(modulePath);
      expect(source, modulePath).not.toMatch(/^import\s+(?!type\b)[\s\S]*?from\s+["']\.\.\/api\//m);
    }
  });

  it("keeps event roots and HTTP routing away from eager handler barrels", () => {
    const indexSource = readSource("../../index.ts");
    expect(indexSource).not.toMatch(/^import\s+(?!type\b)[\s\S]*?from\s+["']\.\/handlers\//m);
    expect(indexSource).toContain('import("./handlers/http/request-dispatch")');
    expect(indexSource).toContain('import("./handlers/scheduled")');

    for (const modulePath of HTTP_ROOT_MODULES) {
      const source = readSource(modulePath);
      expect(source, modulePath).not.toContain("api-utils");
    }

    expect(readSource("../../lib/api-response.ts")).not.toContain('from "./api-freshness"');
    expect(readSource("../dependency-hydrators.ts")).not.toContain('from "../lib/canary-checks"');
    expect(readSource("../../handlers/http/gates.ts")).not.toContain('from "../../lib/api-keys"');
  });
});
