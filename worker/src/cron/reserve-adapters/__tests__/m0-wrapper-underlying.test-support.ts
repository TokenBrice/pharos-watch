import { jsonResponse } from "@shared/test-utils/mock-fetch";

interface Deployment {
  supply: bigint;
  balance: bigint;
  unavailable?: boolean;
}

export function wrapperRpcResponder(options: {
  wrapper: string;
  mToken: string;
  deployments: Record<string, Deployment>;
  swapFacility?: string;
  swapper?: string;
  routeUnavailable?: boolean;
}) {
  const unexpected: string[] = [];
  const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
  const addressWord = (address: string) => address.toLowerCase().slice(2).padStart(64, "0");
  const respond = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: string }] };
    const { to, data } = body.params[0];
    const deployment = options.deployments[url];
    let result: string | undefined;
    if (!deployment || body.method !== "eth_call") {
      unexpected.push(`${url}:${body.method}:${to}:${data}`);
      return null;
    }
    if (deployment.unavailable) return jsonResponse({ error: { code: -32000, message: "eth_call unavailable" } });
    if (to.toLowerCase() === options.wrapper) {
      if (data === "0xc3b6f939") result = addressWord(options.mToken);
      if (data === "0xae06b7e4" && options.swapFacility) result = addressWord(options.swapFacility);
      if (data === "0x18160ddd") result = word(deployment.supply);
      if (data === "0x313ce567") result = word(6);
    }
    if (to.toLowerCase() === options.mToken && data === `0x70a08231${addressWord(options.wrapper)}`) {
      result = word(deployment.balance);
    }
    if (to.toLowerCase() === options.mToken && data === "0x313ce567") result = word(6);
    if (to.toLowerCase() === options.swapFacility) {
      const routeCall = options.swapper && `0xd8e21132${addressWord(options.swapper)}${addressWord(options.wrapper)}${addressWord(options.mToken)}`;
      if (data === "0x5c975abb" || data === routeCall) {
        if (options.routeUnavailable) return jsonResponse({ error: { code: -32000, message: "route probe unavailable" } });
        result = word(data === "0x5c975abb" ? 0 : 1);
      }
    }
    if (result === undefined) {
      unexpected.push(`${url}:${to}:${data}`);
      return null;
    }
    return jsonResponse({ result: `0x${result}` });
  };
  return { respond, unexpected };
}
