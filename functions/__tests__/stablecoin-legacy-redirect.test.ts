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

  it.each([
    ["cg-syrupusdc", "/stablecoin/syrupusdc-maple/"],
    ["gold-kau", "/stablecoin/kau-kinesis/"],
    ["430", "/stablecoin/sofid-sofi/"],
    ["185", "/cemetery/"],
    ["gyd-gyroscope", "/cemetery/"],
    ...["usp-pareto-credit", "xai-silo-finance", "krwo-gimswap", "veur-vnx", "phpm-mento", "usd-nubank"]
      .map((alias) => [alias, "/coverage/"]),
  ])("resolves reviewed legacy alias %s without depending on asset redirects", async (alias, destination) => {
    const ctx = makeContext(new Request(`https://pharos.watch/stablecoin/${alias}/?utm_source=google`, { method: "HEAD" }));
    ctx.assetsFetch.mockImplementation(async () => new Response("missing", { status: 404 }));
    const response = await onRequest(ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`https://pharos.watch${destination}?utm_source=google`);
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

  it.each(["999999", "411"])("passes unreviewed numeric stablecoin %s through to static 404 handling", async (id) => {
    const request = new Request(`https://pharos.watch/stablecoin/${id}/`);
    const ctx = makeContext(request);
    ctx.assetsFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const response = await onRequest(ctx);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    expect(response.headers.has("Location")).toBe(false);

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

  it.each([
    ["/stablecoin/343/", 200],
    ["/stablecoin/usdc-circle/yield/", 404],
  ])("preserves the asset response for POST %s", async (path, status) => {
    const request = new Request(`https://pharos.watch${path}`, { method: "POST" });
    const ctx = makeContext(request);
    ctx.assetsFetch.mockResolvedValueOnce(new Response("asset post", { status }));
    const response = await onRequest(ctx);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("asset post");
    expect(response.headers.has("Location")).toBe(false);
    expect(ctx.assetsFetch).toHaveBeenCalledWith(request);
  });

  it("redirects HEAD for a missing known yield workbench", async () => {
    const ctx = makeContext(new Request("https://pharos.watch/stablecoin/usdc-circle/yield/", { method: "HEAD" }));
    ctx.assetsFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const response = await onRequest(ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://pharos.watch/yield/?compare=usdc-circle&from=detail-fallback&workbenchFallback=usdc-circle",
    );
    expect(await response.text()).toBe("");
  });

  it("waits for discarded asset stream cancellation before returning the redirect", async () => {
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const cancel = vi.fn(() => cancellation);
    const ctx = makeContext(new Request("https://pharos.watch/stablecoin/usdc-circle/yield/"));
    ctx.assetsFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 404 }));
    let settled = false;
    const pending = onRequest(ctx).then((response) => {
      settled = true;
      return response;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
    } finally {
      finishCancellation();
    }
    expect((await pending).status).toBe(302);
  });

  it("preserves an available yield workbench response", async () => {
    const ctx = makeContext(new Request("https://pharos.watch/stablecoin/usdc-circle/yield/"));
    ctx.assetsFetch.mockResolvedValueOnce(new Response("workbench", {
      status: 200,
      headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=60" },
    }));
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("workbench");
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.has("Location")).toBe(false);
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
