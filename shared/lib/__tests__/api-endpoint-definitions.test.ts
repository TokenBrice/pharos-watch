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
      "4ca4875ff880d8ea24d7ae508540fd006d7d49cf4d4ef401d1f0261335f2b012",
    );
  });

  it("keeps mutation, cache-bypass, and access-mode projections unchanged", () => {
    expect(jsonDigest(ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.mutatingAdmin).map((endpoint) => endpoint.path)))
      .toBe("4ea0c9072266719d2f00c74b1ba9565014a48604064072118c93acb0eb89e4d6");
    expect(jsonDigest(ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.cacheBypass).map((endpoint) => endpoint.path)))
      .toBe("65a2aa514bc4338d5c96c99be249ba18addc37d1643409aa806a11a02844a01b");
    expect(jsonDigest(ENDPOINT_DEFINITIONS.map(({ key, publicApiAccess, siteDataAccess }) => ({
      key,
      publicApiAccess,
      siteDataAccess,
    })))).toBe("85e426ae0ae247c2e0248c44a2cd4cba3d272e7e6549e1e1179fcc67d26eb976");
  });
});
