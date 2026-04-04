import { describe, expect, it } from "vitest";
import { addCorsHeaders, handleCorsPreflight, resolveCorsOrigin } from "../cors";

const ALLOWED_ORIGINS = "https://pharos.watch,https://ops.pharos.watch";

describe("cors helpers", () => {
  it("echoes an allowed origin", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { Origin: "https://ops.pharos.watch" },
    });

    const origin = resolveCorsOrigin(request, ALLOWED_ORIGINS);
    expect(origin).toBe("https://ops.pharos.watch");

    const response = addCorsHeaders(new Response("ok"), origin);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://ops.pharos.watch");
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("returns 403 without ACAO for a disallowed OPTIONS preflight", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });

    const origin = resolveCorsOrigin(request, ALLOWED_ORIGINS);
    expect(origin).toBeNull();

    const response = handleCorsPreflight(request, origin);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response?.headers.get("Vary")).toBe("Origin");
  });

  it("omits ACAO for a disallowed non-OPTIONS foreign-origin request", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      method: "GET",
      headers: { Origin: "https://evil.example" },
    });

    const origin = resolveCorsOrigin(request, ALLOWED_ORIGINS);
    expect(origin).toBeNull();

    const response = addCorsHeaders(new Response("ok"), origin);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("keeps the no-Origin fallback behavior", () => {
    const request = new Request("https://api.pharos.watch/api/stablecoins");

    const origin = resolveCorsOrigin(request, ALLOWED_ORIGINS);
    expect(origin).toBe("https://pharos.watch");

    const response = addCorsHeaders(new Response("ok"), origin);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(response.headers.get("Vary")).toBe("Origin");
  });
});
