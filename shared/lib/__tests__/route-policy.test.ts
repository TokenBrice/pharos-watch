import { describe, expect, it } from "vitest";
import {
  getCanonicalPathForMarkdownAsset,
  getGeneratedMarkdownAssetPath,
  isNegotiableMarkdownRoute,
} from "../markdown-route-policy";
import { isCanonicalStablecoinId } from "../stablecoin-id";

describe("canonical stablecoin IDs", () => {
  it.each(["usdc-circle", "a7a5-old-vector", "u"])("accepts %s", (id) => {
    expect(isCanonicalStablecoinId(id)).toBe(true);
  });

  it.each(["", "-usdc", "usdc-", "usdc--circle", "USDC", "../admin", "usdc_circle"])(
    "rejects %s",
    (id) => {
      expect(isCanonicalStablecoinId(id)).toBe(false);
    },
  );
});

describe("generated Markdown route policy", () => {
  it.each(["/methodology/", "/stablecoin/usdc-circle/", "/changelog/", "/digest/2026-07-09/", "/docs/api/"])(
    "maps %s to its generated asset and canonical route",
    (route) => {
      const asset = getGeneratedMarkdownAssetPath(route);
      expect(isNegotiableMarkdownRoute(route)).toBe(true);
      expect(asset).toBe(`${route}index.md`);
      expect(getCanonicalPathForMarkdownAsset(asset!)).toBe(route);
    },
  );

  it.each(["/about/", "/stablecoin/usdc-circle", "/api/status", "/docs/api/readme.md"])(
    "rejects non-generated route %s",
    (route) => {
      expect(isNegotiableMarkdownRoute(route)).toBe(false);
      expect(getGeneratedMarkdownAssetPath(route)).toBeNull();
    },
  );
});
