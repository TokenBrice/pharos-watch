import { encodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";

const ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function coins(uint256) view returns (address)",
  "function decimals() view returns (uint8)",
]);

export function factoryMembershipProof(index: number, pool: `0x${string}`) {
  return {
    callData: encodeFunctionData({ abi: ABI, functionName: "pool_list", args: [BigInt(index)] }),
    returnData: encodeFunctionResult({ abi: ABI, functionName: "pool_list", result: pool }),
  };
}

export function poolCoinProof(index: number, address: `0x${string}`) {
  return {
    callData: encodeFunctionData({ abi: ABI, functionName: "coins", args: [BigInt(index)] }),
    returnData: encodeFunctionResult({ abi: ABI, functionName: "coins", result: address }),
  };
}

export function tokenDecimalsProof(decimals: number) {
  return {
    callData: encodeFunctionData({ abi: ABI, functionName: "decimals" }),
    returnData: encodeFunctionResult({ abi: ABI, functionName: "decimals", result: decimals }),
  };
}
