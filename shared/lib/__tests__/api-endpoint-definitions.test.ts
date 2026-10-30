import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ENDPOINT_DEFINITIONS,
  type EndpointDefinition,
  type EndpointDefinitionByKey,
} from "@shared/lib/api-endpoints/definitions";
import { getStaticEndpointDependenciesByKey } from "@shared/lib/api-endpoints/selectors";
import { validateAllowedEndpointMethods } from "@shared/lib/api-endpoints/validation";

expectTypeOf<EndpointDefinitionByKey<"stablecoins">["key"]>().toEqualTypeOf<"stablecoins">();
expectTypeOf<EndpointDefinitionByKey<"stablecoins">["methods"]>().toEqualTypeOf<readonly ["GET"]>();
expectTypeOf<EndpointDefinitionByKey<"feedback">["methods"]>().toEqualTypeOf<readonly ["POST"]>();
expectTypeOf<EndpointDefinitionByKey<"backfill-dews">["methods"]>()
  .toEqualTypeOf<readonly ["GET", "POST"]>();

const ENDPOINT_DEFINITION_KEYS = [
  "key", "path", "methods", "adminRequired", "mutatingAdmin", "cacheBypass",
  "publicApiAccess", "siteDataAccess", "strictContract", "probeGroup", "probePath",
  "cacheKeyIgnoresQuery", "opsProxyTimeoutMs", "probeSemanticKind", "statusPageAction",
  "routeDependencies",
] as const satisfies readonly (keyof EndpointDefinition)[];

expectTypeOf<Exclude<keyof EndpointDefinition, (typeof ENDPOINT_DEFINITION_KEYS)[number]>>()
  .toEqualTypeOf<never>();

describe("endpoint definition factory parity", () => {
  it.each(["PUT", "DELETE", "PATCH"])("advertises only actual endpoint methods for %s", (method) => {
    expect(validateAllowedEndpointMethods(method, ["POST"])).toEqual({
      message: "Method not allowed", allowedMethods: ["POST"],
    });
    expect(validateAllowedEndpointMethods(method, ["GET"])).toEqual({
      message: "Method not allowed", allowedMethods: ["GET"],
    });
  });

  it("keeps endpoint keys and route paths unambiguous", () => {
    expect(new Set(ENDPOINT_DEFINITIONS.map((endpoint) => endpoint.key)).size).toBe(ENDPOINT_DEFINITIONS.length);
    expect(new Set(ENDPOINT_DEFINITIONS.map((endpoint) => endpoint.path)).size).toBe(ENDPOINT_DEFINITIONS.length);
  });

  it("hydrates blacklist amount-gap remediation with configured chain RPCs", () => {
    expect(getStaticEndpointDependenciesByKey("remediate-blacklist-amount-gaps")).toEqual(["chainRpcs"]);
  });

  // The factory input is a generic constraint, so a mistyped property name
  // compiles but never reaches the selector/route hydration policy. Guard the
  // runtime definition keys against the recognized interface keys.
  it("declares only recognized endpoint definition properties", () => {
    const recognized = new Set<string>(ENDPOINT_DEFINITION_KEYS);
    expect(ENDPOINT_DEFINITIONS.flatMap((endpoint) =>
      Object.keys(endpoint)
        .filter((property) => !recognized.has(property))
        .map((property) => `${endpoint.key}.${property}`),
    )).toEqual([]);
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
