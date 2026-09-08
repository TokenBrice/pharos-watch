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
