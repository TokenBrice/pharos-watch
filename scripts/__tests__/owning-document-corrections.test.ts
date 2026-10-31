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
    expect(mintBurn).toContain("EVM scans use admitted full-log Dwellir before Alchemy");
    expect(mintBurn).toContain("Enabled, admitted Dwellir runs before the chain's incumbent fallback");
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
    expect(consumers).toContain("retained-book sync faults get no public notice");
    expect(consumers).not.toContain("to stale/error/bootstrap/fallback disclosure rows");
    expect(consumers).toContain("to the eligible first-sync bootstrap row only");
  });
});

describe("ADR-42 reserve alert routing", () => {
  const adr = read("docs/architecture.md").split("#### ADR-42")[1]!.split(/\n#### /)[0]!;

  it("records the approved reserve no-Telegram exception and drops the impossible alert gate", () => {
    expect(adr).toContain("Approved exception");
    expect(adr).toContain("send no Telegram");
    expect(adr).toContain("/status");
    expect(adr).toContain("cron-sentinel run metadata");
    expect(adr).not.toContain("pending first production reserve post-sync operator alert");
    // The homepage warning prohibition and other watchdog routes remain.
    expect(adr).toContain("through the sentinel watchdogs");
    expect(adr).toContain("isPublicWarning");
  });
});
