import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_SCHEDULES } from "../../shared/lib/cron-jobs";
import { CRON_SCHEDULE_CADENCES } from "../../shared/lib/cron-cadences";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const mintBurn = read("docs/mint-burn-flows.md");

describe("mint/burn owning document", () => {
  it("states the distinct critical and extended cadences from the cron registry", () => {
    expect(CRON_SCHEDULES.halfHourlyMintBurnCritical).toBe("4,34 * * * *");
    expect(CRON_SCHEDULES.halfHourlyMintBurnExtended).toBe("18 * * * *");
    expect(CRON_SCHEDULE_CADENCES.halfHourlyMintBurnCritical.intervalSec).toBe(1_800);
    expect(CRON_SCHEDULE_CADENCES.halfHourlyMintBurnExtended.intervalSec).toBe(3_600);
    expect(mintBurn).toContain("The critical lane runs every 30 minutes at :04/:34; the extended lane runs hourly at :18.");
    expect(mintBurn).not.toContain("run independently every half hour");
  });

  it("describes admitted Dwellir-first routing everywhere and keeps the exclusions", () => {
    expect(mintBurn).toContain("JSON-RPC (Alchemy alone, or enabled and admitted full-log Dwellir first with Alchemy second)");
    expect(mintBurn).toContain("Enabled, admitted full-log Dwellir runs before Alchemy");
    expect(mintBurn).toContain("mint/burn also requires a supported Alchemy URL (`ALCHEMY_CHAINS` excludes Tempo), and registry support alone does not admit a chain.");
    for (const obsolete of ["Alchemy-first", "reviewed scheduled fallback", "allowlist includes only Ethereum/Arbitrum/Base"]) {
      expect(mintBurn).not.toContain(obsolete);
    }
    expect(mintBurn).toContain("Solana is also excluded");
    expect(mintBurn).toContain("TIP-20");
  });
});

describe("live reserves frontend-consumer disclosures", () => {
  const consumers = read("docs/live-reserves.md").split("## Frontend Consumers")[1]!.split(/\n## /)[0]!;

  it("does not promise a separate sync-error notice or review rows over retained books", () => {
    expect(consumers).not.toContain("collection failures retain their separate sync-error notice");
    expect(consumers).toContain("retained-book sync or refetch faults have no separate public sync notice");
    expect(consumers).not.toContain("to stale/error/bootstrap/fallback disclosure rows");
    expect(consumers).toContain("only to the eligible first-sync bootstrap status row");
  });
});
