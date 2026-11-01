import { describe, expect, it } from "vitest";
import type { StatusCause, StatusResponse, StatusTransition } from "@shared/types";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { normalizeStatusIssues } from "@/lib/status/issue-evidence-model";
import {
  buildTriageHeadline,
  buildTriageInbox,
} from "@/lib/status/triage-inbox";

const NOW = 1_700_000_000;
const CURRENT_EVIDENCE = { state: "current" as const, staleLabels: [], missingLabels: [] };

const cronCause: StatusCause = {
  code: "unhealthy_crons_present",
  layer: "availability",
  severity: "warning",
  message: "1 availability-impacting cron job(s) are unavailable/stale. Jobs: sync-fx-rates.",
  subjects: ["sync-fx-rates"],
};

function transition(at: number, causes: StatusCause[], transitionType: StatusTransition["transitionType"] = "degrade"): StatusTransition {
  return {
    id: at,
    scope: "global",
    from: transitionType === "degrade" ? "healthy" : "degraded",
    to: transitionType === "degrade" ? "degraded" : "healthy",
    rawStatus: "degraded",
    transitionType,
    reason: "test",
    confidence: 1,
    causes,
    at,
  };
}

function withCauses(causes: StatusCause[], timeline: StatusTransition[] = []): StatusResponse {
  const base = makeHealthyStatusResponse();
  const cron = Object.values(base.crons)[0]!;
  return {
    ...base,
    causes: { availability: causes, dataQuality: [], overall: causes },
    timeline,
    crons: { ...base.crons, "sync-fx-rates": { ...cron, expectedIntervalSec: 3600 } },
  };
}

describe("buildTriageInbox", () => {
  it("reports nothing to do on a clean status and refuses to answer on stale evidence", () => {
    const data = withCauses([]);
    const inbox = buildTriageInbox([], data);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "ok", text: "Nothing needs action." });
    expect(buildTriageHeadline(inbox, { state: "stale", staleLabels: ["Public health"], missingLabels: [] }).verdict).toBe(
      "unavailable",
    );
    // Partial evidence that includes a never-loaded required source is not an
    // answerable read, even with no stale label.
    expect(
      buildTriageHeadline(inbox, { state: "partial", staleLabels: [], missingLabels: ["Public health"] }),
    ).toEqual({ verdict: "unavailable", text: "Cannot answer: Public health unavailable. Showing the last good read." });
  });

  it.each([
    "active_price_coverage_incomplete", "ddr_repair_debt_present",
    "reserve_sync_write_uncertain", "reserve_sync_budget_truncated",
  ])("does not promote incidental %s warnings to act", (code) => {
    const gap: StatusCause = {
      code, layer: "data-quality", severity: "warning", message: "An operator diagnostic remains open.",
    };
    const data = withCauses([gap], [600, 1200, 1800].map((age) =>
      transition(NOW - age, [gap, cronCause]),
    ));
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.act).toHaveLength(0);
    expect(inbox.watch[0]).toMatchObject({ verdict: "watch", recurrence: 3 });
  });

  it("watches bounded listing and mint/burn notices alongside small unwaived price gaps", () => {
    const data = withCauses([
      { code: "stablecoin_publication_incomplete", layer: "data-quality", severity: "info", message: "1 of 396 listings missing." },
      { code: "mint_burn_public_degraded", layer: "availability", severity: "info", message: "Fresh healthy lane; execution notice." },
      { code: "active_price_coverage_incomplete", layer: "data-quality", severity: "warning", message: "2 unacknowledged price gaps." },
    ]);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.act).toHaveLength(0);
    expect(inbox.items.every((item) => item.verdict === "watch")).toBe(true);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE).verdict).toBe("watch");
  });

  it("does not queue a reviewed nominal-reference notice as a watch item", () => {
    const data = withCauses([
      { code: "active_price_coverage_nominal_reference", layer: "data-quality", severity: "info", message: "Reviewed nominal references, not observed market prices. These are not missing-price gaps." },
    ]);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.items).toHaveLength(0);
    expect(inbox.watch).toHaveLength(0);
    expect(inbox.informational).toHaveLength(0);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "ok", text: "Nothing needs action." });
  });

  it.each(["stablecoin_publication_unknown", "stablecoin_publication_incomplete", "mint_burn_public_stale", "db_unhealthy"])(
    "keeps genuine %s service impact actionable", (code) => {
      const data = withCauses([{ code, layer: "availability", severity: "warning", message: "Service impact." }]);
      expect(buildTriageInbox(normalizeStatusIssues(data.causes), data).act).toHaveLength(1);
    },
  );

});

