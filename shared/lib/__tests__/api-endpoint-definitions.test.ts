import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ENDPOINT_DEFINITIONS,
  type EndpointDefinitionByKey,
} from "@shared/lib/api-endpoints/definitions";

describe("endpoint definition factory parity", () => {
  it("preserves inferred literal keys and method tuples", () => {
    expectTypeOf<EndpointDefinitionByKey<"stablecoins">["key"]>().toEqualTypeOf<"stablecoins">();
    expectTypeOf<EndpointDefinitionByKey<"stablecoins">["methods"]>().toEqualTypeOf<readonly ["GET"]>();
    expectTypeOf<EndpointDefinitionByKey<"feedback">["methods"]>().toEqualTypeOf<readonly ["POST"]>();
    expectTypeOf<EndpointDefinitionByKey<"audit-depeg-history">["methods"]>()
      .toEqualTypeOf<readonly ["GET", "POST"]>();
  });

  it("keeps endpoint keys and route paths unambiguous", () => {
    expect(new Set(ENDPOINT_DEFINITIONS.map((endpoint) => endpoint.key)).size).toBe(ENDPOINT_DEFINITIONS.length);
    expect(new Set(ENDPOINT_DEFINITIONS.map((endpoint) => endpoint.path)).size).toBe(ENDPOINT_DEFINITIONS.length);
  });

  it("keeps donor claims wallet-authenticated and outside site-data caching", () => {
    expect(ENDPOINT_DEFINITIONS.find((endpoint) => endpoint.key === "donor-key-claim")).toMatchObject({
      path: "/api/donor-key-claims", methods: ["POST"],
      adminRequired: false, mutatingAdmin: false, cacheBypass: true,
      publicApiAccess: "exempt", siteDataAccess: "denied",
    });
  });

  it("restricts broadcast mutations to uncached admin POST requests", () => {
    expect(ENDPOINT_DEFINITIONS.find((endpoint) => endpoint.key === "admin-telegram-broadcast")).toMatchObject({
      path: "/api/admin-telegram-broadcast", methods: ["POST"],
      adminRequired: true, mutatingAdmin: true, cacheBypass: true,
      publicApiAccess: "exempt", siteDataAccess: "denied",
    });
  });
});
