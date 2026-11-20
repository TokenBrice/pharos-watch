import { type Failure, read } from "./shared";

/**
 * Issue #1683 (escrow/unmatched-supply slice): the four compact-grades rows
 * transcribed from public/datasets/scores-latest/2026-11-07.json (git blob
 * 43ad3e6ba05463ba63c3cc3de37d0c6857f835c0 — the public generator prunes
 * snapshots after 90 days, so checks never read the prunable file). Shared by
 * worker/src/lib/__tests__/safety-score-v9-extension-supply.test.ts and the
 * doc-sync check below: the log's historical reason-code claim is compared
 * against this fixture, so neither side can drift alone.
 */
export const ISSUE_1683_COMPACT_GRADES_ROWS = [
  { stablecoinId: "reusd-re-protocol", logName: "reUSD", ratingStatus: "rated", partialEvidence: null, reasonCodes: ["material-reserve-slice-unstructured", "nonmaterial-bridge-supply-unmatched", "runtime-bridge-materiality-unavailable", "unresolved-control-identity"] },
  { stablecoinId: "susn-noon", logName: "sUSN", ratingStatus: "rated", partialEvidence: null, reasonCodes: ["material-reserve-slice-unstructured", "nonmaterial-bridge-supply-unmatched", "selected-bridge-route-unresolved", "unresolved-control-identity"] },
  { stablecoinId: "nopal-nest", logName: "nOPAL", ratingStatus: "rated", partialEvidence: null, reasonCodes: ["bounded-mechanism-review", "material-reserve-slice-unstructured", "missing-runtime-route-evidence", "missing-same-notional-route", "nonmaterial-bridge-supply-unmatched", "selected-bridge-route-unresolved", "unresolved-control-identity"] },
  { stablecoinId: "susde-ethena", logName: "sUSDe", ratingStatus: "rated", partialEvidence: null, reasonCodes: ["unresolved-control-identity"] },
];

const FILE = "docs/process/report-cards-evidence-log.md";
const SECTION_HEADING = "## Escrow and Unmatched-Supply Rows — 2026-11-20";
const REASON = "nonmaterial-bridge-supply-unmatched";

/** Fail-closed prerequisites an editor must not silently drop from the section. */
const REQUIRED_CLAIMS: ReadonlyArray<readonly [label: string, needle: string]> = [
  ["susde-aptos-escrow-binding", "no pinned peer or transfer proves the Aptos FA draws on the Ethereum adapter escrow"],
  ["susde-aptos-attribution-blocked", "Aptos attribution stays blocked until a pinned peer setting or a bridging transfer proves the escrow binding"],
  ["susde-tempo-peer-one-way", "does not prove the adapter ever paired with Tempo or that the Tempo token's only mint path is the adapter escrow"],
  ["susn-extension-escrow-proof", "any extension must first prove that each added leg draws on the escrow being debited"],
  ["susn-extension-timing-reconcile", "— and reconcile pending bridge messages and cross-read timing against the pinned reads; the unmatched row remains"],
  ["nopal-accepted-partition-blocker", "Blocker: the accepted supply partition behind an accepted generation"],
  ["nopal-partition-reconciliation", "reconcile the accepted supply partition's positive-share rows after any admitted provider-row exclusions"],
  ["nopal-diagnostics-subordinate", "use join diagnostics only to explain individual joins"],
  ["nopal-subthreshold-residual-both-lists", "absent from both `unmatchedRowIdentities` and `unprovenRouteJoins`"],
];

const TON_CITATION = "[STON.fi Ethena staking page](https://ethena.ston.fi/)";

/** Inline code is not rendered prose: a citation met only inside backticks never renders its destination. */
const withoutInlineCode = (section: string): string => section.replace(/`[^`]*`/g, "");

const englishList = (names: readonly string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function checkReportCardsEvidenceLog(failures: Failure[], readDocument: typeof read): void {
  const section = readDocument(FILE).split(SECTION_HEADING)[1]?.split("\n## ")[0];
  if (section === undefined) {
    failures.push({ file: FILE, label: "issue-1683 evidence section", expected: SECTION_HEADING, found: null });
    return;
  }
  for (const [label, needle] of REQUIRED_CLAIMS) {
    if (!section.includes(needle)) failures.push({ file: FILE, label: `issue-1683 ${label}`, expected: needle, found: null });
  }
  // The TON citation must RENDER to its destination: the markdown link has to
  // exist outside inline code, where a quoted correct-looking string could
  // otherwise stand in beside a swapped live link.
  if (!withoutInlineCode(section).includes(TON_CITATION)) {
    failures.push({ file: FILE, label: "issue-1683 susde-ton-citation-link", expected: TON_CITATION, found: null });
  }
  // The log's historical assignment must match the archived rows it cites.
  const carriers = ISSUE_1683_COMPACT_GRADES_ROWS.filter((row) => row.reasonCodes.includes(REASON)).map((row) => row.logName);
  const withoutBridgeReason = ISSUE_1683_COMPACT_GRADES_ROWS.filter(
    (row) => !row.reasonCodes.some((code) => code.includes("bridge-supply")),
  ).map((row) => row.logName);
  const claim = `on ${englishList(carriers)} and no bridge-supply reason on ${englishList(withoutBridgeReason)}`;
  if (!section.includes(claim)) {
    failures.push({ file: FILE, label: "issue-1683 historical reason-code claim", expected: claim, found: null });
  }
}
