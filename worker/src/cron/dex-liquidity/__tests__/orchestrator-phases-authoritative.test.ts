import { describe, expect, it } from "vitest";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";

describe("buildAuthoritativeStagedPoolConfirmationIndex", () => {
  it("enforces confirmation for clean authoritative protocol fetches even when no pools were returned", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["plasma"],
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.get("balancer")).toEqual(new Set(["plasma"]));
    expect(index.confirmedExactKeysByProtocol.get("balancer")).toEqual(new Set());
  });

  it("fails open for warning-only authoritative protocol fetches", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Meteora",
        circuitKey: "meteora-api",
        normalizedProtocol: "meteora",
        supportedChains: ["solana"],
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("fails open when the authoritative fetch has a real failure", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["plasma"],
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["partial"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });

  it("fails open when the authoritative fetch has mixed warnings and real failures", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Meteora",
        circuitKey: "meteora-api",
        normalizedProtocol: "meteora",
        supportedChains: ["solana"],
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["meteora page 2 returned 503"],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });
});
