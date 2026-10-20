import { describe, expect, it, vi } from "vitest";
import {
  getClientVariantParent,
  getClientVariantRelationship,
  getClientVariants,
} from "../client-variant-registry";

vi.mock("@shared/lib/stablecoins/client-registry", () => {
  const graph = [
    { id: "parent" },
    { id: "child", variantOf: "parent", variantKind: "risk-absorption" },
    { id: "sibling", variantOf: "parent", variantKind: "pure-wrapper", status: "active" },
    { id: "unrelated", variantOf: "other", variantKind: "pure-wrapper" },
    { id: "orphan", variantOf: "absent", variantKind: "pure-wrapper" },
    { id: "missing-kind", variantOf: "parent" },
    { id: "missing-parent-id", variantKind: "pure-wrapper" },
    ...(["pre-launch", "quarantined", "delisted", "frozen"] as const).map((status) => ({
      id: status, variantOf: "parent", variantKind: "pure-wrapper", status,
    })),
  ];
  const active = graph.filter((coin) => coin.status == null || coin.status === "active");
  return {
    CLIENT_ACTIVE_META_BY_ID: new Map(active.map((coin) => [coin.id, coin])),
    CLIENT_ACTIVE_STABLECOINS: active,
  };
});

describe("client variant registry", () => {
  it("resolves a parent and exactly its other children, excluding unrelated variants", () => {
    expect(getClientVariantParent("child")?.id).toBe("parent");
    expect(getClientVariantParent("parent")).toBeNull();
    const relationship = getClientVariantRelationship("child");
    expect(relationship?.parent.id).toBe("parent");
    expect(relationship?.kind).toBe("risk-absorption");
    expect(relationship?.siblings.map((coin) => coin.id)).toEqual(["sibling", "missing-kind"]);
    expect(getClientVariants("parent").map((coin) => coin.id)).toEqual(["child", "sibling", "missing-kind"]);
  });

  it("returns no relationships for an unknown id", () => {
    expect(getClientVariantParent("unknown")).toBeNull();
    expect(getClientVariantRelationship("unknown")).toBeNull();
    expect(getClientVariants("unknown")).toEqual([]);
  });

  it("does not invent a parent relationship for an authored orphan", () => {
    expect(getClientVariantParent("orphan")).toBeNull();
    expect(getClientVariantRelationship("orphan")).toBeNull();
    expect(getClientVariants("absent").map((coin) => coin.id)).toEqual(["orphan"]);
  });

  it.each(["missing-kind", "missing-parent-id"])("requires complete variant metadata for %s", (id) => {
    expect(getClientVariantParent(id)).toBeNull();
    expect(getClientVariantRelationship(id)).toBeNull();
  });

  it.each(["pre-launch", "quarantined", "delisted", "frozen"])("excludes %s client relationships", (id) => {
    expect(getClientVariantParent(id)).toBeNull();
    expect(getClientVariantRelationship(id)).toBeNull();
    expect(getClientVariants("parent").map((coin) => coin.id)).not.toContain(id);
  });
});
