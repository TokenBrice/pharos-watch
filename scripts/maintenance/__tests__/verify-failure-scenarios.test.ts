import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FailureScenariosByIdSchema } from "@shared/lib/failure-scenarios";
import {
  FAILURE_SCENARIO_CHECKS, scenarioDocumentWatch, scenarioSourceAddress,
  type ScenarioCheckContext, type ScenarioDocument, type ScenarioReadClient,
} from "@shared/lib/failure-scenario-checks";
import { documentText } from "../verify-failure-scenarios";

const records = FailureScenariosByIdSchema.parse(JSON.parse(readFileSync("data/failure-scenarios.json", "utf8")));
const record = records["usds-sky"]!;
const watch = scenarioDocumentWatch("terms", "Fixture terms", [{ sourceId: "terms", publisher: "Fixture" }], "Human review required.");
const documentRecord = { ...record, sources: [{ id: "terms", label: "Fixture terms", url: "https://example.com/terms" as const, observedAt: "2026-10-07" }] };

function document(html: string, metadata: Partial<NonNullable<ScenarioDocument["fingerprint"]>> = {}): ScenarioDocument {
  const normalizedText = documentText(html);
  return {
    sourceId: "terms", url: "https://example.com/terms", publisher: "Fixture", fetchedAt: "2026-10-07T12:00:00.000Z", normalizedText,
    fingerprint: { contentHash: createHash("sha256").update(normalizedText).digest("hex"), revision: null, lastModified: null, etag: null, ...metadata },
  };
}

async function compareDocuments(recorded: ScenarioDocument, fetched: ScenarioDocument) {
  return watch.run({ record: documentRecord, chains: {}, memo: new Map(), documentWatch: { recorded: [recorded], fetched: [fetched] } });
}

function html(noise: string, substance = "Verified customers may redeem at a minimum of $100,000.") {
  return `<html><head><script nonce="${noise}">window.timestamp="${noise}";window.session="${noise}";</script><link href="/assets/${noise}.css?cache=${noise}"></head><body><main data-build-id="${noise}"><h1>Redemption terms</h1><p>Last updated: February 26, 2026</p><p>${substance}</p><img src="/assets/${noise}.png?token=${noise}"><a href="/fees?session=${noise}">Fees</a></main><footer>Request ${noise}</footer></body></html>`;
}

describe("scenario document substance fingerprints", () => {
  it("excludes per-request scripts, nonces, build ids, rotating assets, sessions and cache-busters", async () => {
    const before = document(html("request-one"));
    const after = document(html("request-two"));
    expect(before.normalizedText).toBe(after.normalizedText);
    expect((await compareDocuments(before, after)).verdict).toBe("holds");
    expect(before.normalizedText).toContain("Last updated: February 26, 2026");
  });

  it("reports moved Last-Modified and ETag as evidence without changing the verdict", async () => {
    const before = document(html("one"), { lastModified: "Wed, 30 Sep 2026 18:10:04 GMT", etag: '"edge-one"' });
    const after = document(html("two"), { lastModified: "Wed, 30 Sep 2026 18:09:44 GMT", etag: '"edge-two"' });
    const result = await compareDocuments(before, after);
    expect(result.verdict).toBe("holds");
    expect(result.observed).toMatchObject({ differences: [], transportMetadataChanges: [{ sourceId: "terms", recorded: { lastModified: before.fingerprint!.lastModified, etag: '"edge-one"' }, observed: { lastModified: after.fingerprint!.lastModified, etag: '"edge-two"' } }] });
  });

  it("still detects an injected substantive redemption edit with unchanged transport headers", async () => {
    const result = await compareDocuments(document(html("one")), document(html("two", "Every holder may redeem without any minimum.")));
    expect(result.verdict).toBe("changed");
    expect(result.observed).toMatchObject({ differences: [{ sourceId: "terms", observedExcerpt: expect.stringContaining("Every holder") }] });
  });

  it("retains printed date changes and independently compares printed revisions", async () => {
    const before = document(html("one"));
    const after = document(html("two").replace("February 26, 2026", "October 7, 2026"));
    expect((await compareDocuments(before, after)).verdict).toBe("changed");
    expect((await compareDocuments(before, { ...before, fingerprint: { ...before.fingerprint!, revision: "Version October 7, 2026" } })).verdict).toBe("changed");
  });

  it("retains the PDF byte-hash safeguard and source identity checks", async () => {
    const before = document(html("one"), { fileHash: "a".repeat(64) });
    expect((await compareDocuments(before, document(html("one"), { fileHash: "b".repeat(64) }))).verdict).toBe("changed");
    expect((await compareDocuments(before, { ...before, url: "https://example.com/replaced-terms" })).verdict).toBe("changed");
  });
});

function skyContext(overrides: { hat?: string; pauseAuthority?: string; pauseProxy?: string; proxyOwner?: string; currentCode?: string; approvals?: bigint } = {}): ScenarioCheckContext {
  const chief = scenarioSourceAddress(record, "chief");
  const pause = scenarioSourceAddress(record, "pause");
  const proxy = scenarioSourceAddress(record, "pause-proxy");
  const client = {
    readContract: vi.fn(async ({ address, functionName, blockNumber }: { address: string; functionName: string; blockNumber: bigint }) => {
      switch (functionName) {
        case "hat": return overrides.hat ?? scenarioSourceAddress(record, "sitting-hat");
        case "owner": return address.toLowerCase() === pause.toLowerCase() ? "0x0000000000000000000000000000000000000000" : overrides.proxyOwner ?? pause;
        case "authority": return overrides.pauseAuthority ?? chief;
        case "proxy": return overrides.pauseProxy ?? proxy;
        case "approvals": return blockNumber === 26139200n ? 7044339374n * 10n ** 18n : overrides.approvals ?? 7044269284n * 10n ** 18n;
        default: throw new Error(`Unexpected read ${functionName}`);
      }
    }),
    getBytecode: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => blockNumber === 26139200n ? "0x6000" : overrides.currentCode ?? "0x6000"),
  } as unknown as ScenarioReadClient;
  return { record, chains: { 1: { client, blockNumber: 26140166n } }, memo: new Map() };
}

const skyChecks = FAILURE_SCENARIO_CHECKS["usds-sky"]!.checks;
const structuralChecks = skyChecks.filter((check) => check.id === "hat-approvals-bar");

describe("Sky structural governance bar and live figure", () => {
  it("keeps ordinary approval-weight movement informational", async () => {
    const context = skyContext();
    for (const check of structuralChecks) expect((await check.run(context)).verdict).toBe("holds");
    const figure = skyChecks.find((check) => check.id === "hat-approval-weight")!;
    expect(figure.kind).toBe("figure");
    expect(await figure.run(context)).toMatchObject({ verdict: "changed", observed: { approvalsSky: "7044269284", approvalsWad: (7044269284n * 10n ** 18n).toString() } });
  });

  it.each(["hat", "pauseAuthority", "pauseProxy", "proxyOwner"] as const)("detects a changed %s", async (field) => {
    const result = await structuralChecks[0]!.run(skyContext({ [field]: "0x0000000000000000000000000000000000000001" }));
    expect(result.verdict).toBe("changed");
  });

  it("detects changed Chief/route runtime without treating weight as structural", async () => {
    for (const check of structuralChecks) expect((await check.run(skyContext({ currentCode: "0x6001" }))).verdict).toBe("changed");
  });
});
