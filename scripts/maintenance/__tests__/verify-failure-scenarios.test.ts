import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { FailureScenariosByIdSchema } from "@shared/lib/failure-scenarios";
import * as scenarioRegistry from "@shared/lib/failure-scenario-checks";
import {
  scenarioDocumentWatch, scenarioSourceAddress,
} from "@shared/lib/failure-scenario-checks/context";
import type {
  ScenarioCheckContext, ScenarioDocument, ScenarioReadClient,
} from "@shared/lib/failure-scenario-checks/context";
import { documentText } from "../verify-failure-scenarios";

const { FAILURE_SCENARIO_CHECKS } = scenarioRegistry;

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

describe("scenario check import direction", () => {
  it("keeps helpers registry-free and every registered leaf below the registry", () => {
    const imports = (name: string) => {
      const source = readFileSync(`shared/lib/failure-scenario-checks/${name}.ts`, "utf8");
      return ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true)
        .statements.filter(ts.isImportDeclaration);
    };
    const contextImports = imports("context");
    expect(contextImports.map((entry) => entry.moduleSpecifier.getText())).toEqual([
      '"viem"', '"../../types/failure-scenarios"',
    ]);
    expect(contextImports.every((entry) => entry.importClause?.isTypeOnly)).toBe(true);
    for (const id of Object.keys(FAILURE_SCENARIO_CHECKS)) {
      const localImports = imports(id).map((entry) => entry.moduleSpecifier.getText())
        .filter((specifier) => specifier.startsWith('"./'));
      expect(localImports, id).toContain('"./context"');
      expect(localImports.every((specifier) => specifier === '"./context"'), id).toBe(true);
    }
    expect(Object.keys(scenarioRegistry)).toEqual(["FAILURE_SCENARIO_CHECKS"]);
  });
});

describe("scenario document substance fingerprints", () => {
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
  it.each(["hat", "pauseAuthority", "pauseProxy", "proxyOwner"] as const)("detects a changed %s", async (field) => {
    const result = await structuralChecks[0]!.run(skyContext({ [field]: "0x0000000000000000000000000000000000000001" }));
    expect(result.verdict).toBe("changed");
  });

  it("detects changed Chief/route runtime without treating weight as structural", async () => {
    for (const check of structuralChecks) expect((await check.run(skyContext({ currentCode: "0x6001" }))).verdict).toBe("changed");
  });
});

const capChecks = FAILURE_SCENARIO_CHECKS["cusd-cap"]!.checks;
const capZeroWord = `0x${"0".repeat(64)}`;
const capCloneTarget = "d8063123bba3b480569244ae66bfe72b6c84b00d";
const capCloneCode = `0x363d3d373d3d3d363d73${capCloneTarget}5af43d82803e903d91602b57fd5bf3`;

function capContext(overrides: {
  storage?: { slot: "guard" | "module"; value: string | undefined };
  bytecode?: { value: string | undefined };
  supply?: bigint;
  borrows?: bigint;
} = {}): ScenarioCheckContext {
  const client = {
    getStorageAt: vi.fn(async ({ slot }: { slot: string }) => {
      const kind = slot === "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" ? "guard" : "module";
      return overrides.storage?.slot === kind ? overrides.storage.value : capZeroWord;
    }),
    getBytecode: vi.fn(async () => overrides.bytecode ? overrides.bytecode.value : capCloneCode),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getThreshold": return 3n;
        case "getOwners": return Array.from({ length: 5 }, (_, i) => `0x${(i + 2).toString(16).padStart(40, "0")}`);
        case "roles": return 16383n;
        case "totalSupply": return overrides.supply ?? 100n * 10n ** 18n;
        case "totalBorrows": return overrides.borrows ?? 76n * 10n ** 6n;
        default: throw new Error(`Unexpected Cap read ${functionName}`);
      }
    }),
  } as unknown as ScenarioReadClient;
  return { record: records["cusd-cap"]!, chains: { 1: { client, blockNumber: 26176412n } }, memo: new Map() };
}

function runCapCheck(id: string, overrides: Parameters<typeof capContext>[0] = {}) {
  return capChecks.find((check) => check.id === id)!.run(capContext(overrides));
}

describe("Cap pinned falsifier evidence", () => {
  it.each(["guard", "module"] as const)("rejects unavailable or malformed %s storage rather than inventing zero", async (slot) => {
    for (const value of [undefined, "", "0x", "0x00", `0x${"0".repeat(63)}`, `0x${"g".repeat(64)}`, `0x${"0".repeat(66)}`]) {
      await expect(runCapCheck("safe-composition", { storage: { slot, value } })).rejects.toMatchObject({
        name: "ScenarioReadUnavailableError",
        message: expect.stringContaining("Storage word unavailable"),
      });
    }
  });

  it("retains complete zero words as observed empty Safe state", async () => {
    const result = await runCapCheck("safe-composition");
    expect(result).toMatchObject({
      verdict: "holds",
      observed: { threshold: 3, ownerCount: 5, guard: `0x${"0".repeat(40)}`, moduleHead: "none" },
    });
  });

  it.each([
    { borrows: 24_999_999n, verdict: "changed", displayed: 24.99 },
    { borrows: 25_000_000n, verdict: "changed", displayed: 25 },
    { borrows: 25_000_001n, verdict: "holds", displayed: 25 },
  ])("uses exact quarter comparison for $borrows raw USDC units", async ({ borrows, verdict, displayed }) => {
    const result = await runCapCheck("operator-lending-share", { borrows });
    expect(result).toMatchObject({ verdict, observed: { borrowSharePct: displayed } });
  });

  it("accepts only the complete reviewed minimal proxy with the required roles", async () => {
    expect(await runCapCheck("fr-vault-roles")).toMatchObject({
      verdict: "holds",
      observed: { roleMask: "16383", missingRequiredBits: [], cloneTarget: `0x${capCloneTarget}` },
    });
  });

  it.each([
    `0x003d3d373d3d3d363d73${capCloneTarget}5af43d82803e903d91602b57fd5bf3`,
    `0x363d3d373d3d3d363d73${capCloneTarget}5af43d82803e903d91602b57fd5bf2`,
    `0x613fff5f5260205ff300${capCloneTarget}${"00".repeat(15)}`,
    `0x363d3d373d3d3d363d73${"0".repeat(40)}5af43d82803e903d91602b57fd5bf3`,
  ])("detects a runtime or target change even with all role bits: %s", async (value) => {
    expect((await runCapCheck("fr-vault-roles", { bytecode: { value } })).verdict).toBe("changed");
  });

  it.each([undefined, "", "0x", "0x0", "0xzz"])("preserves missing or malformed runtime as unavailable: %s", async (value) => {
    await expect(runCapCheck("fr-vault-roles", { bytecode: { value } })).rejects.toMatchObject({
      name: "ScenarioReadUnavailableError",
      message: expect.stringContaining("Bytecode unavailable"),
    });
  });
});
