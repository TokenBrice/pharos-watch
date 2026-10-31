import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRpcAuth, type ChainRpcConfig } from "../chain-registry";
import { fetchEvmUint256AtBlock, requestJsonRpcAtUrl } from "../evm-rpc";

const { recordCredits } = vi.hoisted(() => ({ recordCredits: vi.fn() }));
vi.mock("../rpc-provider-budget", () => ({ recordDwellirCredits: recordCredits }));

const dwellirUrl = "https://api-bsc-mainnet-full.n.dwellir.com";
const registryUrl = "https://bsc-public-a.example";

function chainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([["bsc", {
    chainId: "bsc",
    chainName: "BSC",
    type: "evm",
    explorerUrl: "https://explorer.example",
    endpoints: [
      { url: registryUrl, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" },
      { url: dwellirUrl, operator: "dwellir", keyed: true, position: "supplemental", stateHistory: "archive", logsHistory: "full" },
    ],
  }]]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Dwellir HTTP error classification", () => {
  it("keeps a Dwellir origin eligible after a non-JSON HTTP 403 on the same run", async () => {
    registerRpcAuth("dwellir", dwellirUrl, { "X-Api-Key": "dwellir-key" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(dwellirUrl)) {
        // An edge/WAF rejection: HTTP 403 with an HTML/plain-text body.
        return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const run = chainRpcs();

    expect(await fetchEvmUint256AtBlock("bsc", "0xToken", "0x18160ddd", "latest", { chainRpcs: run, maxRetries: 0 }))
      .toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([dwellirUrl, registryUrl]);

    fetchMock.mockClear();
    expect(await fetchEvmUint256AtBlock("bsc", "0xToken", "0x18160ddd", "latest", { chainRpcs: run, maxRetries: 0 }))
      .toBeNull();
    // docs/worker-and-api-limits.md: "HTTP/RPC errors alone do not ban it".
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([dwellirUrl, registryUrl]);
  });

  it("classifies an unreadable non-OK response body as HTTP evidence, not a no-response failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedBody = new ReadableStream({
      start(controller) { controller.error(new Error("body unavailable")); },
    });
    const fetchMock = vi.fn(async () => new Response(failedBody, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await requestJsonRpcAtUrl(
      "https://rpc.example",
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { maxRetries: 0 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("http-error");
    if (outcome.status === "http-error") {
      expect(outcome.response.status).toBe(502);
      expect(outcome.body).toBeNull();
      expect(outcome.rows.size).toBe(0);
      expect(outcome.invalidRows).toBe(0);
    }
  });
});
