import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import {
  BRLA_NOTION_PIN,
  buildBrlaReserveSlices,
  fetchAndVerifyBrlaPdf,
  verifyBrlaNotionDiscovery,
} from "../brla-independent-assurance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
const ROOT_RECORD = {
  recordMap: {
    block: {
      [BRLA_NOTION_PIN.rootPageId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.rootPageId,
            type: "page",
            properties: { title: [[BRLA_NOTION_PIN.rootPageTitle]] },
            content: BRLA_NOTION_PIN.rootContent,
          },
        },
      },
    },
  },
};

const YEAR_RECORD = {
  recordMap: {
    block: {
      [BRLA_NOTION_PIN.yearBlockId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.yearBlockId,
            type: "header",
            properties: { title: [[BRLA_NOTION_PIN.yearTitle]] },
          },
        },
      },
      [BRLA_NOTION_PIN.reportBlockId]: {
        spaceId: "space",
        value: {
          value: {
            id: BRLA_NOTION_PIN.reportBlockId,
            type: "file",
            properties: {
              title: [[BRLA_NOTION_PIN.attachmentTitle]],
              source: [[BRLA_NOTION_PIN.attachmentSource]],
            },
          },
        },
      },
    },
  },
};

const SIGNED_URL = `https://file.notion.so/f/f/space/${BRLA_NOTION_PIN.attachmentId}/Avenia_-_Transparency_Report_-_20260731_(Audit_Attestation).pdf?table=block&id=${BRLA_NOTION_PIN.reportBlockId}&spaceId=space&expirationTimestamp=1788998400000&signature=signature`;

function installFetch(options: { rootRecord?: unknown; yearRecord?: unknown; signedUrl?: string; indexUrl?: string } = {}) {
  const {
    rootRecord = ROOT_RECORD,
    yearRecord = YEAR_RECORD,
    signedUrl = SIGNED_URL,
    indexUrl = "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  } = options;
  const loadPageChunkUrl = "https://brladigital.notion.site/api/v3/loadPageChunk";
  const signedFileUrlsUrl = "https://brladigital.notion.site/api/v3/getSignedFileUrls";
  return installAdapterNetwork({
    html: { [indexUrl]: "<html>official index</html>" },
    json: {
      [loadPageChunkUrl]: async (request: Request) => {
        const body = JSON.parse(await request.clone().text()) as { pageId?: string };
        const record = body.pageId === BRLA_NOTION_PIN.rootPageId
          ? rootRecord
          : body.pageId === BRLA_NOTION_PIN.yearBlockId
            ? yearRecord
            : { recordMap: { block: {} } };
        return { json: record, url: request.url };
      },
      [signedFileUrlsUrl]: { json: { signedUrls: [signedUrl] }, url: signedFileUrlsUrl },
      [signedUrl]: new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: { "content-type": "application/pdf" },
      }),
    },
  });
}

const discoveryArgs = (overrides: Record<string, unknown> = {}) => ({
  manifest: getIndependentAssuranceManifest("BRLA"),
  indexUrl: "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  indexHost: "brladigital.notion.site",
  reportHosts: ["file.notion.so"],
  signal: AbortSignal.timeout(1000),
  ...overrides,
});

describe("BRLA Notion reviewed discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the reviewed July report through pinned block identity", async () => {
    installFetch();
    const result = await verifyBrlaNotionDiscovery(discoveryArgs());
    expect(result.signedUrl).toBe(SIGNED_URL);
    expect(result.sourceTimestamp).toBe(Math.floor(Date.parse("2026-07-31T23:59:59+00:00") / 1000));
  });

  it("fails closed when the root page title drifts", async () => {
    installFetch({
      rootRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.rootPageId]: {
              spaceId: "space",
              value: { value: { id: BRLA_NOTION_PIN.rootPageId, type: "page", properties: { title: [["Rebranded page"]] }, content: BRLA_NOTION_PIN.rootContent } },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("page identity drifted");
  });

  it("fails closed when the root child tree changes (e.g. a new year group)", async () => {
    installFetch({
      rootRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.rootPageId]: {
              spaceId: "space",
              value: { value: { id: BRLA_NOTION_PIN.rootPageId, type: "page", properties: { title: [[BRLA_NOTION_PIN.rootPageTitle]] }, content: [...BRLA_NOTION_PIN.rootContent, "new-block-id"] } },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("index structure changed");
  });

  it("fails closed when the report attachment drifts", async () => {
    installFetch({
      yearRecord: {
        recordMap: {
          block: {
            [BRLA_NOTION_PIN.yearBlockId]: YEAR_RECORD.recordMap.block[BRLA_NOTION_PIN.yearBlockId],
            [BRLA_NOTION_PIN.reportBlockId]: {
              spaceId: "space",
              value: {
                value: {
                  id: BRLA_NOTION_PIN.reportBlockId,
                  type: "file",
                  properties: {
                    title: [[BRLA_NOTION_PIN.attachmentTitle]],
                    source: [["attachment:drifted:Avenia_-_Transparency_Report_-_20260731_(Audit_Attestation).pdf"]],
                  },
                },
              },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("attachment drifted");
  });

  it("fails closed when a newer unreviewed report appears in the 2026 tree", async () => {
    const augustBlockId = "4d77f28f-0ae4-80fb-bd17-f3ca9b5d3490";
    installFetch({
      yearRecord: {
        recordMap: {
          block: {
            ...YEAR_RECORD.recordMap.block,
            [augustBlockId]: {
              spaceId: "space",
              value: {
                value: {
                  id: augustBlockId,
                  type: "file",
                  properties: { title: [["Avenia - Transparency Report - 20260831 (Audit Attestation).pdf"]] },
                },
              },
            },
          },
        },
      },
    });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("newer unreviewed report 20260831");
  });

  it("fails closed when the signed URL identity drifts", async () => {
    installFetch({ signedUrl: "https://file.notion.so/f/f/space/other-attachment/report.pdf?table=block&id=other-block&signature=x" });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("signed URL attachment identity drifted");
  });

  it("fails closed on a non-reviewed signed URL host", async () => {
    installFetch({ signedUrl: `https://evil.example/${BRLA_NOTION_PIN.attachmentId}/report.pdf?table=block&id=${BRLA_NOTION_PIN.reportBlockId}` });
    await expect(verifyBrlaNotionDiscovery(discoveryArgs())).rejects.toThrow("signed URL host is not reviewed");
  });

  it("reconciles all four chain liabilities to BRL and rejects an omitted chain", () => {
    const manifest = getIndependentAssuranceManifest("BRLA");
    expect(reconcileIndependentAssuranceManifest(manifest)).toMatchObject({
      computedAssetTotal: "126110433.68",
      liabilityTotal: "116923169.82",
    });
    expect(manifest.liabilities).toContainEqual({ code: "moonbeam", label: "Moonbeam Chain BRLA redeemable tokens", amount: "4294.09" });
    expect(() => reconcileIndependentAssuranceManifest({
      ...manifest,
      liabilities: manifest.liabilities.filter((row) => row.code !== "moonbeam"),
    })).toThrow("liability total 116918875.73 does not match manifest 116923169.82");
  });
});

describe("BRLA PDF byte verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xaa, 0xbb]);
  const manifest = {
    ...getIndependentAssuranceManifest("BRLA"),
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    reportByteLength: bytes.length,
  };

  function installBinaryFetch(changed = false) {
    const body = changed
      ? (() => {
        const next = new Uint8Array(bytes);
        next[next.length - 1] = 0xcc;
        return next;
      })()
      : bytes;
    return installAdapterNetwork({
      json: {
        [SIGNED_URL]: new Response(body, { headers: { "content-type": "application/pdf" } }),
      },
    });
  }

  it("accepts reviewed bytes", async () => {
    installBinaryFetch();
    const result = await fetchAndVerifyBrlaPdf({
      manifest,
      signedUrl: SIGNED_URL,
      reportHosts: ["file.notion.so"],
      signal: AbortSignal.timeout(1000),
    });
    expect(result.byteLength).toBe(bytes.length);
  });

  it("rejects drifted bytes", async () => {
    installBinaryFetch(true);
    await expect(fetchAndVerifyBrlaPdf({
      manifest,
      signedUrl: SIGNED_URL,
      reportHosts: ["file.notion.so"],
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow("PDF SHA-256");
  });
});

describe("BRLA asset classification", () => {
  it("publishes an unknown-class slice and degrades for an unreviewed asset code", () => {
    const reviewed = getIndependentAssuranceManifest("BRLA");
    const withUnknown = {
      ...reviewed,
      assets: [...reviewed.assets, { code: "unreviewed-holdings", label: "Unreviewed holdings", amount: "123.45" }],
    };

    const { slices, unknownExposurePct, warnings } = buildBrlaReserveSlices(withUnknown);

    const unreviewed = slices.find((slice) => slice.sourceKey === "brla-independent-assurance:brla:unreviewed-holdings");
    expect(unreviewed).toMatchObject({ name: "Unreviewed holdings", risk: "high", liquidityHorizon: "unknown" });
    expect(unreviewed).not.toHaveProperty("assetClass");
    expect(unknownExposurePct).toBeGreaterThan(0);
    expect(warnings).toEqual([expect.objectContaining({
      code: "brla-asset-code-unclassified",
      effect: "degraded",
    })]);
  });

  it("rejects an unparsable asset amount", () => {
    const reviewed = getIndependentAssuranceManifest("BRLA");
    const garbage = {
      ...reviewed,
      assets: [{ code: "cash-and-cash-equivalents", label: "Cash", amount: "not-a-number" }],
    };

    expect(() => buildBrlaReserveSlices(garbage)).toThrow("unparsable asset amount");
  });
});
