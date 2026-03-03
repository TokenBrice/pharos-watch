import strictPaths from "./strict-contract-paths.json";

export const STRICT_CONTRACT_PATHS_LIST = strictPaths as readonly string[];

export const STRICT_CONTRACT_PATHS_SET = new Set<string>(STRICT_CONTRACT_PATHS_LIST);
