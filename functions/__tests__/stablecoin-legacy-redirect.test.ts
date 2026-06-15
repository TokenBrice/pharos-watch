import { describe, expect, it, vi } from "vitest";
import { onRequest, resolveLegacyStablecoinRedirect } from "../stablecoin/[[path]]";

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
});
