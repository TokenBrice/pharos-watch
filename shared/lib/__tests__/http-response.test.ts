import { describe, expect, it } from "vitest";
import { createJsonErrorResponse, createJsonResponse } from "../http-response";

describe("JSON HTTP response factories", () => {
  it("serializes bodies with status, JSON content type, and custom headers", async () => {
    const response = createJsonResponse({ ok: true }, {
      status: 202,
      headers: { "X-Test": "yes" },
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Test")).toBe("yes");
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });

  it("builds the shared error envelope without imposing cache policy", async () => {
    const response = createJsonErrorResponse(429, "slow down", {
      headers: { "Retry-After": "12" },
    });
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(response.headers.get("Retry-After")).toBe("12");
    await expect(response.json()).resolves.toEqual({ error: "slow down" });
  });
});
