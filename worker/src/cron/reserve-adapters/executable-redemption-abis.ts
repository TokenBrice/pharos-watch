import { parseAbi } from "viem/utils";

/**
 * Contract ABIs read by the specialized executable-redemption observers.
 * Declared once here because the observers and their tests must issue the
 * identical calls: a second copy in either file is a clone the duplicated-code
 * ratchet rejects.
 */
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
export const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
]);
