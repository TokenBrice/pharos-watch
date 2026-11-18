import { CME_CALENDAR_REVIEW_DEADLINE_SEC, MENTO_CALENDAR_REVIEW_DEADLINE_SEC } from "../../shared/lib/reference-market-hours";
import { REVIEWED_BUSINESS_CALENDARS } from "../../shared/data/business-calendars/reviewed";
import { BUSINESS_CALENDAR_BOUND_POLICY, firstBusinessDaySettlementCoverageLoss } from "../../shared/lib/business-calendars";
import { REDEMPTION_BACKSTOP_CONFIGS } from "../../shared/lib/redemption-backstop-configs";
import { reviewedRedemptionSettlementExpirySec } from "../../shared/lib/redemption-backstop-configs/settlement";
import { DAY_SECONDS } from "../../shared/lib/time-constants";
import { runDirectCli } from "../lib/cli-args.mjs";

const renewalLeadSec = 60 * DAY_SECONDS;
const utc = (sec: number) => new Date(sec * 1_000).toISOString();

function checkDeadline(label: string, deadline: number | null, now: number): boolean {
  if (deadline === null || !Number.isFinite(deadline)) {
    console.error(`${label} has no provable calendar horizon`);
    return false;
  }
  const renewBy = deadline - renewalLeadSec;
  const message = `${label} expires ${utc(deadline)} (review due ${utc(renewBy)})`;
  if (now >= renewBy) {
    console.error(message);
    return false;
  }
  console.log(message);
  return true;
}

export function checkCalendarHorizon(now: number): boolean {
  let ok = checkDeadline("CME", CME_CALENDAR_REVIEW_DEADLINE_SEC, now);
  if (!checkDeadline("Mento", MENTO_CALENDAR_REVIEW_DEADLINE_SEC, now)) ok = false;
  for (const [id, config] of Object.entries(REDEMPTION_BACKSTOP_CONFIGS)) {
    const review = config.v9RouteReviewTerms;
    const terms = review?.businessDayTerms;
    if (!review || !terms || terms.conditional || terms.assurance !== "binding-guarantee") continue;
    const calendar = REVIEWED_BUSINESS_CALENDARS[terms.calendarId];
    const firstUncovered = firstBusinessDaySettlementCoverageLoss(terms, calendar);
    const calendarExpiry = Date.parse(calendar.reviewedAt) / 1_000 + BUSINESS_CALENDAR_BOUND_POLICY.reviewedMaxAgeSec + 1;
    const termsExpiry = reviewedRedemptionSettlementExpirySec(review);
    const deadline = firstUncovered === null || termsExpiry === null
      ? null : Math.min(firstUncovered, calendarExpiry, termsExpiry);
    if (!checkDeadline(`${id} ${terms.calendarId}`, deadline, now)) ok = false;
  }
  return ok;
}

runDirectCli(import.meta.url, () => {
  if (!checkCalendarHorizon(Math.floor(Date.now() / 1_000))) process.exitCode = 1;
});
