export function makeSafeControl(
  overrides: Record<string, unknown> = {},
  safeOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chain: "ethereum",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    label: "Issuer mint Safe",
    role: "direct-minter",
    authorityType: "safe",
    directMintAbility: "direct",
    threshold: 2,
    signerCount: 3,
    modulesOrGuardsStatus: "none-detected",
    safe: {
      owners: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ],
      threshold: 2,
      observedBlock: 123456,
      source: "onchain",
      ...safeOverrides,
    },
    ...overrides,
  };
}

export function makeBridgeAuthority(control: Record<string, unknown>): Record<string, unknown> {
  const { chain, address, role: _role, directMintAbility: _ability, ...authority } = control;
  return {
    tier: "issuer-native-burn-mint",
    summary: "Reviewed fixture bridge authority and its exact deployment.",
    reviewedAt: "2026-05-24",
    reviewer: "Fixture reviewer",
    confidence: "verified",
    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
    routes: [{
      id: "ethereum:0x1111111111111111111111111111111111111111",
      destinationChain: "ethereum",
      contractAddress: "0x1111111111111111111111111111111111111111",
      protocol: "Fixture bridge",
      issuanceModel: "native-issuance",
      routeClass: "native",
      riskTier: "single-chain-or-native",
      semantics: "native-mint",
      scope: "canonical",
      reviewDisposition: "reviewed",
      observedAt: "2026-05-24",
      sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
    }],
    controls: [{
      id: "fixture-bridge-authority",
      routeRefs: ["ethereum:0x1111111111111111111111111111111111111111"],
      capabilities: ["admin"],
      controllerChain: chain,
      controllerAddress: address,
      ...authority,
    }],
  };
}
