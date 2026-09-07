import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ENDPOINT_DEFINITIONS,
  type EndpointDefinitionByKey,
} from "../api-endpoints/definitions";

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("endpoint definition factory parity", () => {
  it("preserves inferred literal keys and method tuples", () => {
    expectTypeOf<EndpointDefinitionByKey<"stablecoins">["key"]>().toEqualTypeOf<"stablecoins">();
    expectTypeOf<EndpointDefinitionByKey<"stablecoins">["methods"]>().toEqualTypeOf<readonly ["GET"]>();
    expectTypeOf<EndpointDefinitionByKey<"feedback">["methods"]>().toEqualTypeOf<readonly ["POST"]>();
    expectTypeOf<EndpointDefinitionByKey<"audit-depeg-history">["methods"]>()
      .toEqualTypeOf<readonly ["GET", "POST"]>();
  });

  it("keeps the complete runtime definition snapshot unchanged", () => {
    expect(jsonDigest(ENDPOINT_DEFINITIONS)).toBe(
      "1580682fd41e529e7d882aa490c28db840819f5e5696368322dc9e7314ae355b",
    );
  });

  it("keeps mutation, cache-bypass, and access-mode projections unchanged", () => {
    expect(jsonDigest(ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.mutatingAdmin).map((endpoint) => endpoint.path)))
      .toBe("4ea0c9072266719d2f00c74b1ba9565014a48604064072118c93acb0eb89e4d6");
    expect(jsonDigest(ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.cacheBypass).map((endpoint) => endpoint.path)))
      .toBe("c378b541fe5bfd2e345e5e7f742214b54641beb504b05ee398d1b95c7894b6e8");
    expect(jsonDigest(ENDPOINT_DEFINITIONS.map(({ key, publicApiAccess, siteDataAccess }) => ({
      key,
      publicApiAccess,
      siteDataAccess,
    })))).toBe("680e8bbb4b9780958b48d3b14001bccc9dd2fa4416978476c935dbce922e5e35");
  });
});
