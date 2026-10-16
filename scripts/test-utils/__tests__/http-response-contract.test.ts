import { describe, expect, it } from "vitest";
import {
  matchesHttpResponseObservation,
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
