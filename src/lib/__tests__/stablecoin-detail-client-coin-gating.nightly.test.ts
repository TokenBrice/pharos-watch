// Nightly tier: PR coverage retained by src/lib/__tests__/stablecoin-detail-client-coin-gating.test.ts
import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MAX_MINT_AUTHORITY_DETAIL_CONTROLS } from "../stablecoin-detail-mint-authority-client";
import { buildStablecoinDetailClientCoin } from "../stablecoin-detail-client-coin";

const SUMMARY_KEYS = ["mintPath", "authorityPosture", "confidence", "summary", "headline", "inheritedFrom",
  "mintIncidents", "controls", "totalControlCount", "controlCensusUrl", "sources", "reviewedAt",
  "sourceFreeRationale", "unresolvedQuestions"];

const CONTROL_KEYS = ["label", "role", "authorityType", "directMintAbility", "chain", "address", "threshold",
  "signerCount", "timelockDelaySec", "capDescription", "canRaiseCap", "modulesOrGuardsStatus", "keyCustodyAttestation"];

const CONTROL_PRIORITY: Record<string, number> = {
  direct: 0,
  "can-authorize": 1,
  unknown: 2,
  "cap-limited": 3,
  "upgrade-only": 4,
  "parameter-only": 5,
  none: 6,
};

describe("buildStablecoinDetailClientCoin registry projection", () => {
  it("projects only allowed mint-authority fields across the validated registry and inherited parents", () => {
    let checked = 0;
    for (const coin of TRACKED_META_BY_ID.values()) {
      const client = buildStablecoinDetailClientCoin(coin, { parentById: TRACKED_META_BY_ID });
      const profile = coin.mintAuthority;
      if (!profile) {
        expect(client).not.toHaveProperty("mintAuthoritySummary");
        continue;
      }
      const summary = client.mintAuthoritySummary!;
      expect(Object.keys(summary).every((key) => SUMMARY_KEYS.includes(key)), coin.id).toBe(true);
      expect(summary).toMatchObject({
        mintPath: profile.mintPath, authorityPosture: profile.authorityPosture,
        confidence: profile.confidence, summary: profile.summary,
      });
      const authored = profile.controls ?? [];
      const selected = authored.length > MAX_MINT_AUTHORITY_DETAIL_CONTROLS
        ? [...authored].sort((a, b) => CONTROL_PRIORITY[a.directMintAbility] - CONTROL_PRIORITY[b.directMintAbility])
            .slice(0, MAX_MINT_AUTHORITY_DETAIL_CONTROLS)
        : authored;
      expect(summary.controls?.map((control) => control.label) ?? []).toEqual(selected.map((control) => control.label));
      for (const control of summary.controls ?? []) {
        expect(Object.keys(control).every((key) => CONTROL_KEYS.includes(key)), coin.id).toBe(true);
        if (control.keyCustodyAttestation) expect(Object.keys(control.keyCustodyAttestation)).toEqual(["kind", "sources"]);
      }
      expect(new Set(summary.sources?.map((source) => source.url)).size).toBe(summary.sources?.length ?? 0);
      expect(client).not.toHaveProperty("mintAuthorityParentSummaries");
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
