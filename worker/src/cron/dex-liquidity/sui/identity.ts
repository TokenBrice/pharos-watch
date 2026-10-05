export const SUI_CLMM_DEPLOYMENTS = {
  cetus: {
    profileId: "cetus-clmm-exact-v1",
    typePackage: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
    quotePackage: "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3",
    quoteFunction: "calculate_swap_result",
    configId: "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
  },
  bluefin: {
    profileId: "bluefin-spot-clmm-exact-v1",
    typePackage: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267",
    quotePackage: "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c",
    quoteFunction: "calculate_swap_results",
    configId: null,
  },
} as const;
export type SuiClmmFamily = keyof typeof SUI_CLMM_DEPLOYMENTS;

export function suiObjectId(value: string): string | null {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) ? `0x${value.slice(2).toLowerCase().padStart(64, "0")}` : null;
}

/** Move identifiers are case-sensitive; only their package address is normalized. */
export function suiCoinType(value: string): string | null {
  const match = /^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z_0-9]*)::([A-Za-z_][A-Za-z_0-9]*)$/.exec(value.trim());
  const address = match && suiObjectId(match[1]);
  return match && address ? `${address}::${match[2]}::${match[3]}` : null;
}

export function suiClmmFamily(project: string): SuiClmmFamily | null {
  if (project === "cetus" || project === "cetus-clmm") return "cetus";
  if (project === "bluefin" || project === "bluefin-spot") return "bluefin";
  return null;
}

/** Never interpret a UUID/fingerprint or an address-like suffix as a pool object. */
export function suiClmmPoolId(value: string): string | null {
  return suiObjectId(value.startsWith("sui:") ? value.slice(4) : value);
}
