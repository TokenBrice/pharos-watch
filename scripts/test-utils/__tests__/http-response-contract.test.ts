import { describe, expect, it } from "vitest";
import {
  matchesHttpResponseObservation,
  observeHttpResponse,
  type HttpResponseObservation,
} from "@shared/test-utils/http-response-contract";

describe("HTTP response contract observer", () => {
  const jsonGolden = {
    status: 200,
    headers: { "content-type": "application/json", "x-contract": "stable" },
    bodyKind: "json",
    canonicalBody: {
      alpha: { a: 1, z: 2 },
      items: [{ a: "first", z: "last" }, "array-order-is-preserved"],
    },
  } satisfies HttpResponseObservation;

  it("normalizes allowlisted header casing and canonicalizes JSON object keys", async () => {
    const observed = await observeHttpResponse(
      new Response(
        JSON.stringify({
          items: [{ z: "last", a: "first" }, "array-order-is-preserved"],
          alpha: { z: 2, a: 1 },
        }),
        { headers: { "Content-Type": "application/json", "X-Contract": "stable", "X-Ignored": "volatile" } },
      ),
      ["CONTENT-type", "x-contract"],
    );

    expect(observed).toEqual(jsonGolden);
    expect(matchesHttpResponseObservation(observed, jsonGolden)).toBe(true);
  });

  it("observes text and empty responses", async () => {
    await expect(
      observeHttpResponse(new Response("Malformed URI", { headers: { "Content-Type": "text/plain" } })),
    ).resolves.toEqual({ status: 200, headers: {}, bodyKind: "text", canonicalBody: "Malformed URI" });
    await expect(observeHttpResponse(new Response(null, { status: 204 }))).resolves.toEqual({
      status: 204,
      headers: {},
      bodyKind: "empty",
      canonicalBody: null,
    });
  });

  it("compares object keys structurally", () => {
    expect(
      matchesHttpResponseObservation(
        { status: 200, headers: { a: "1", b: "2" }, bodyKind: "json", canonicalBody: { a: 1, b: 2 } },
        { status: 200, headers: { b: "2", a: "1" }, bodyKind: "json", canonicalBody: { b: 2, a: 1 } },
      ),
    ).toBe(true);
  });

  it("rejects intentional status, header, body, and array-order mutations", () => {
    const mutations: HttpResponseObservation[] = [
      { ...jsonGolden, status: 201 },
      { ...jsonGolden, headers: { ...jsonGolden.headers, "x-contract": "changed" } },
      { ...jsonGolden, canonicalBody: { ...jsonGolden.canonicalBody, alpha: { a: 1, z: 3 } } },
      {
        ...jsonGolden,
        canonicalBody: {
          ...jsonGolden.canonicalBody,
          items: ["array-order-is-preserved", { a: "first", z: "last" }],
        },
      },
    ];

    for (const mutation of mutations) {
      expect(matchesHttpResponseObservation(mutation, jsonGolden)).toBe(false);
    }
  });
});
