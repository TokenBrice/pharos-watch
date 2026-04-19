import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../admin/[[path]].ts";

describe("admin host gate", () => {
  it("returns 404 outside the configured ops host", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/admin/"),
      env: {
        ASSETS: { fetch: vi.fn() as typeof fetch },
        OPS_UI_ORIGIN: "https://ops.pharos.watch",
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("serves the asset on the configured ops host", async () => {
    const assetsFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/admin/"),
      env: {
        ASSETS: { fetch: assetsFetch as typeof fetch },
        OPS_UI_ORIGIN: "https://ops.pharos.watch",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("ok");
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });
});
