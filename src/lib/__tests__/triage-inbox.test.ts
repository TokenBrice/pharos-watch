import { describe, expect, it } from "vitest";
import type { StatusCause, StatusTransition } from "@shared/types/status/core";
import type { StatusResponse } from "@shared/types/status/response";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { normalizeStatusIssues } from "@/lib/status/issue-evidence-model";
import {
  buildTriageHeadline,
  buildTriageInbox,
} from "@/lib/status/triage-inbox";

const NOW = 1_700_000_000;
const CURRENT_EVIDENCE = { state: "current" as const, staleLabels: [], missingLabels: [], refreshErrorLabels: [] };

function cause(code: string, severity: StatusCause["severity"] = "info", layer: StatusCause["layer"] = "data-quality"): StatusCause {
  return { code, severity, layer, message: code };
}

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
  it("answers only with current evidence", () => {
    const data = withCauses([]);
    const inbox = buildTriageInbox([], data);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "ok", text: "Nothing needs action." });
    expect(buildTriageHeadline(inbox, { ...CURRENT_EVIDENCE, state: "stale", staleLabels: ["Public health"] }).verdict).toBe(
      "unavailable",
    );
    // Never-loaded required evidence is not answerable.
    expect(
      buildTriageHeadline(inbox, { ...CURRENT_EVIDENCE, state: "partial", missingLabels: ["Public health"] }),
    ).toEqual({ verdict: "unavailable", text: "Cannot answer: Public health unavailable. Showing the last good read." });
  });

  it.each([{ causes: [] }, { causes: [cronCause] }])("withholds a verdict after a retained-data refresh failure ($causes)", ({ causes }) => {
    const data = withCauses(causes);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    const headline = buildTriageHeadline(inbox, { ...CURRENT_EVIDENCE, state: "partial", refreshErrorLabels: ["Public health", "Status API"] });
    expect(headline.verdict).toBe("unavailable");
    expect(headline.text).toBe("Cannot answer: Public health, Status API refresh failed. Showing the last good read.");
    expect(inbox.act).toHaveLength(causes.length);
  });

  it.each([
    "active_price_coverage_incomplete", "ddr_repair_debt_present",
    "reserve_sync_write_uncertain", "reserve_sync_budget_truncated",
  ])("does not promote incidental %s warnings to act", (code) => {
    const gap = cause(code, "warning");
    const data = withCauses([gap], [600, 1200, 1800].map((age) =>
      transition(NOW - age, [gap, cronCause]),
    ));
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.act).toHaveLength(0);
    expect(inbox.watch[0]).toMatchObject({ verdict: "watch", recurrence: 3 });
  });

  it("watches listing, mint/burn and price notices", () => {
    const data = withCauses([
      cause("stablecoin_publication_incomplete"),
      cause("mint_burn_public_degraded", "info", "availability"),
      cause("active_price_coverage_incomplete", "warning"),
    ]);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.act).toHaveLength(0);
    expect(inbox.items.every((item) => item.verdict === "watch")).toBe(true);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE).verdict).toBe("watch");
  });

  it("filters standing notices but queues reminders and alert-eligible gaps", () => {
    const data = withCauses([
      cause("active_price_coverage_nominal_reference"),
      cause("reserve_feed_reviews_acknowledged"),
      cause("active_price_coverage_incomplete"),
    ]);
    const firstGeneration = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(firstGeneration.informational.map((item) => item.issue.code)).toEqual(["active_price_coverage_incomplete"]);
    expect(buildTriageHeadline(firstGeneration, CURRENT_EVIDENCE).text).toBe("Nothing needs action. Watching 1.");
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes, [], true), data);
    expect(inbox.items).toHaveLength(0);
    expect(inbox.informational).toHaveLength(0);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "ok", text: "Nothing needs action." });

    const warning: StatusCause = { ...data.causes.overall[2], severity: "warning" };
    const mixed = buildTriageInbox(normalizeStatusIssues(data.causes, [warning], true), data);
    expect(mixed.watch.map((item) => item.issue.code)).toEqual(["active_price_coverage_incomplete"]);
    expect(buildTriageHeadline(mixed, CURRENT_EVIDENCE)).toEqual({ verdict: "watch", text: "Nothing needs action. Watching 1." });

    const reviewCodes = [
      "price_gap_reviews_expiring", "reserve_feed_reviews_expiring",
      "price_gap_reviews_expired", "reserve_feed_reviews_expired",
      "price_gap_reviews_invalid", "reserve_feed_reviews_invalid",
    ];
    const reminders = withCauses(reviewCodes.map((code) => cause(code)));
    const reminderInbox = buildTriageInbox(normalizeStatusIssues(reminders.causes), reminders);
    expect(reminderInbox.informational.map((item) => item.issue.code).sort()).toEqual([...reviewCodes].sort());
    expect(buildTriageHeadline(reminderInbox, CURRENT_EVIDENCE).text).toBe("Nothing needs action. Watching 6.");
  });

  it.each(["stablecoin_publication_unknown", "stablecoin_publication_incomplete", "mint_burn_public_stale", "db_unhealthy"])(
    "keeps genuine %s service impact actionable", (code) => {
      const data = withCauses([cause(code, "warning", "availability")]);
      expect(buildTriageInbox(normalizeStatusIssues(data.causes), data).act).toHaveLength(1);
    },
  );

});

