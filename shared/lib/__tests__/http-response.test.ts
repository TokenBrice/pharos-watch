import { describe, expect, it } from "vitest";
import { cloneResponse, createJsonErrorResponse, createJsonResponse } from "../http-response";

describe("cloneResponse", () => {
  it("preserves status text, headers, and a streamed body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 202,
      statusText: "Accepted upstream",
      headers: [["Warning", "199 first"], ["Warning", "199 second"]],
    });

    const cloned = cloneResponse(response);

    expect(cloned.status).toBe(202);
    expect(cloned.statusText).toBe("Accepted upstream");
    expect([...cloned.headers]).toEqual([...response.headers]);
    expect(cloned.headers.get("Warning")).toBe("199 first, 199 second");
    await expect(cloned.text()).resolves.toBe("streamed");
  });

  it("strips HEAD bodies and applies header mutations", async () => {
    const cloned = cloneResponse(new Response("body", { headers: { "X-Test": "old" } }), {
      method: "HEAD",
      mutateHeaders: (headers) => headers.set("X-Test", "new"),
    });

    expect(cloned.headers.get("X-Test")).toBe("new");
    await expect(cloned.text()).resolves.toBe("");
  });

  it("supports explicit body and header replacement", async () => {
    const cloned = cloneResponse(new Response("old", { headers: { "X-Old": "1" } }), {
      body: "new",
      headers: { "X-New": "2" },
    });

    expect(cloned.headers.get("X-Old")).toBeNull();
    expect(cloned.headers.get("X-New")).toBe("2");
    await expect(cloned.text()).resolves.toBe("new");
  });
});

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
