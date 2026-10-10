import { afterEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({ default: filesystem }));
vi.mock("@shared/data/stablecoins/coins.generated.json", () => ({
  default: [
    { id: "usdc-circle", geckoId: "usd-coin" },
    { id: "usdt-tether", geckoId: "tether" },
    { id: "frax-frax", geckoId: "frax" },
    { id: "dai-makerdao", geckoId: "dai" },
  ],
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("fetch-logos maintenance", () => {
  it("preserves fetched and unfetched canonical local logos while filling missing provider images", async () => {
    vi.resetModules();
    filesystem.readFileSync.mockReturnValue(JSON.stringify({
      "usdc-circle": "/logos/usdc-circle.svg",
      "dai-makerdao": "/logos/dai-makerdao.png",
      "usdt-tether": "https://old.example/tether.png",
      "1": "/logos/legacy-numeric.svg",
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith("https://stablecoins.llama.fi/")) {
        return Response.json({ peggedAssets: [
          { gecko_id: "usd-coin" }, { gecko_id: "tether" }, { gecko_id: "frax" },
        ] });
      }
      return Response.json([
        { id: "usd-coin", image: "https://assets.example/large/usdc.png" },
        { id: "tether", image: "https://assets.example/large/usdt.png" },
        { id: "frax", image: "https://assets.example/large/frax.png" },
        { id: "unknown-provider-id", image: "https://assets.example/large/unknown.png" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    // Import after installing fixtures: this entrypoint starts its maintenance run at module load.
    await import("../fetch-logos");
    await vi.waitFor(() => expect(filesystem.writeFileSync).toHaveBeenCalledOnce());
    const [outputPath, output] = filesystem.writeFileSync.mock.calls[0] as [string, string];
    expect(outputPath).toMatch(/\/data\/logos\.json$/);
    expect(JSON.parse(output)).toEqual({
      "usdc-circle": "/logos/usdc-circle.svg",
      "dai-makerdao": "/logos/dai-makerdao.png",
      "usdt-tether": "https://assets.example/small/usdt.png",
      "frax-frax": "https://assets.example/small/frax.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
