import { describe, expect, it, vi } from "vitest";
import {
  onRequest,
  resolveLegacyStablecoinRedirect,
  resolveMissingYieldWorkbenchRedirect,
} from "../stablecoin/[[path]]";

function makeContext(request: Request) {
  const assetsFetch = vi.fn(async () => new Response("asset", { status: 200 }));
  return {
    request,
    env: {
      ASSETS: {
        fetch: assetsFetch,
      },
    },
    assetsFetch,
  };
}

describe("stablecoin legacy redirects", () => {
  it("redirects old DefiLlama numeric stablecoin URLs to canonical Pharos IDs", async () => {
    const ctx = makeContext(new Request("https://pharos.watch/stablecoin/343/"));

    const response = await onRequest(ctx);

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://pharos.watch/stablecoin/usat-tether/");
    expect(ctx.assetsFetch).not.toHaveBeenCalled();
  });

  it("preserves query strings on numeric redirects", async () => {
    const ctx = makeContext(new Request("https://pharos.watch/stablecoin/343/?utm_source=google"));

    const response = await onRequest(ctx);

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "https://pharos.watch/stablecoin/usat-tether/?utm_source=google",
    );
  });

  it("passes canonical stablecoin routes through to static assets", async () => {
    const request = new Request("https://pharos.watch/stablecoin/usat-tether/");
    const ctx = makeContext(request);

    const response = await onRequest(ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(ctx.assetsFetch).toHaveBeenCalledWith(request);
  });

  it("passes unknown numeric stablecoin routes through to static 404 handling", async () => {
    const request = new Request("https://pharos.watch/stablecoin/999999/");
    const ctx = makeContext(request);

    await onRequest(ctx);

    expect(ctx.assetsFetch).toHaveBeenCalledWith(request);
  });

  it("does not redirect PSI-only shadow assets without public detail pages", async () => {
    const request = new Request("https://pharos.watch/stablecoin/3/");
    const ctx = makeContext(request);

    await onRequest(ctx);

    expect(ctx.assetsFetch).toHaveBeenCalledWith(request);
  });

  it("does not build redirects from malformed generated target IDs", () => {
    expect(
      resolveLegacyStablecoinRedirect(
        new URL("https://pharos.watch/stablecoin/343/?utm_source=google"),
        {
          "343": "../admin",
        },
      ),
    ).toBeNull();
    expect(
      resolveLegacyStablecoinRedirect(new URL("https://pharos.watch/stablecoin/344/"), {
        "344": "https://evil.example/stablecoin/usdc-circle",
      }),
    ).toBeNull();
  });

  it("redirects a known missing yield workbench to the filtered yield surface", async () => {
    const request = new Request("https://pharos.watch/stablecoin/usdc-circle/yield/?days=90");
    const assetsFetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const response = await onRequest({
      request,
      env: { ASSETS: { fetch: assetsFetch } },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://pharos.watch/yield/?days=90&compare=usdc-circle&from=detail-fallback&workbenchFallback=usdc-circle",
    );
  });

  it("preserves existing yield state while binding the notice to the requested coin", () => {
    const target = resolveMissingYieldWorkbenchRedirect(
      new URL(
        "https://pharos.watch/stablecoin/usdc-circle/yield/?compare=usdt-tether&from=watchlist&workbenchFallback=spoofed&days=30",
      ),
      404,
      new Set(["usdc-circle"]),
    );

    expect(target).not.toBeNull();
    const redirected = new URL(target!);
    expect(redirected.pathname).toBe("/yield/");
    expect(redirected.searchParams.get("compare")).toBe("usdt-tether");
    expect(redirected.searchParams.get("from")).toBe("watchlist");
    expect(redirected.searchParams.get("days")).toBe("30");
    expect(redirected.searchParams.getAll("workbenchFallback")).toEqual(["usdc-circle"]);
  });

  it("rejects an oversized fallback id even if a supplied registry marks it known", () => {
    const oversizedId = "a".repeat(65);
    expect(
      resolveMissingYieldWorkbenchRedirect(
        new URL(`https://pharos.watch/stablecoin/${oversizedId}/yield/`),
        404,
        new Set([oversizedId]),
      ),
    ).toBeNull();
  });

  it("keeps unknown or available yield routes on static asset handling", () => {
    const known = new Set(["usdc-circle"]);
    expect(
      resolveMissingYieldWorkbenchRedirect(
        new URL("https://pharos.watch/stablecoin/usdc-circle/yield/"),
        200,
        known,
      ),
    ).toBeNull();
    expect(
      resolveMissingYieldWorkbenchRedirect(
        new URL("https://pharos.watch/stablecoin/not-tracked/yield/"),
        404,
        known,
      ),
    ).toBeNull();
  });
});
