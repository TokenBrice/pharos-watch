import { describe, it, expect } from "vitest";
import { boatStyleFor } from "./classification-to-boat";

describe("boatStyleFor", () => {
  it("centralized + reserve = galleon", () => {
    expect(boatStyleFor({ governance: "centralized", backing: "rwa-backed" })).toBe("galleon");
  });

  it("centralized-dependent = brigantine", () => {
    expect(boatStyleFor({ governance: "centralized-dependent", backing: "rwa-backed" })).toBe("brigantine");
  });

  it("decentralized = schooner", () => {
    expect(boatStyleFor({ governance: "decentralized", backing: "crypto-backed" })).toBe("schooner");
  });

  it("algorithmic backing overrides to junk regardless of governance", () => {
    expect(boatStyleFor({ governance: "decentralized", backing: "algorithmic" })).toBe("junk");
    expect(boatStyleFor({ governance: "centralized", backing: "algorithmic" })).toBe("junk");
  });

  it("missing governance falls back to schooner", () => {
    expect(boatStyleFor({ governance: undefined, backing: "crypto-backed" })).toBe("schooner");
  });
});
