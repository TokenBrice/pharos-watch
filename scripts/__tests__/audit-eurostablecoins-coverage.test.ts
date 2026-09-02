import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildAudit, loadSupportedChains, renderMarkdown } from "../maintenance/audit-eurostablecoins-coverage";
it("imports the real chain registry without changing report bytes", () => {
  const chains = loadSupportedChains();
  const audit = buildAudit({ externalCoins: [], localCoins: [], deadCoins: [], supportedChains: chains, generatedAt: "2026-09-01T00:00:00.000Z", apiUrl: "fixture" });
  expect(createHash("sha256").update(JSON.stringify([chains.has("polygon-zkevm"), `${JSON.stringify(audit, null, 2)}\n`, renderMarkdown(audit)])).digest("hex")).toBe("24f35c41b0df9fdf90647232c0489d9bd4a01def6013b4f2d5e1e28039287f4a");
});
