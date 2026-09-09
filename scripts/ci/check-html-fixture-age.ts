#!/usr/bin/env node
/**
 * Scheduled owner of the reserve HTML fixture capture bound.
 *
 * Adapter fixtures are captures of live issuer dashboards, so their value
 * decays with the calendar rather than with any diff: a fixture nobody
 * refreshed for months anchors the parsers to markup that no longer exists.
 * This gate fails when a live fixture is older than
 * `HTML_FIXTURE_MAX_AGE_DAYS`, when its `captured-at` header is missing or
 * unparsable, or when a capture claims to be from the future — a header that
 * postdates `now` is a wrong clock or a hand-edited provenance line, and it
 * would otherwise buy the fixture an unbounded extension of the age bound.
 *
 * It runs from `.github/workflows/weekly-validation.yml`, never from the PR
 * gate: the verdict moves with the date, so a PR that touches nothing would
 * otherwise start failing on a Tuesday.
 *
 * Fixtures carrying an `<!-- archived: reason -->` header are deliberately
 * frozen regression inputs and are exempt from the staleness bound, but their
 * capture metadata still has to be parsable and non-future.
 */

import { reportViolations } from "../lib/report-violations.mts";
import { runAsCli } from "../lib/source-files.mts";
import {
  HTML_FIXTURE_REFRESH_TARGETS,
  type HtmlFixtureCapture,
  type HtmlFixtureRefreshTarget,
  readHtmlFixtureCaptures,
} from "../maintenance/refresh-reserve-html-fixtures.ts";

/** Bound in whole days: a capture fails once it is a 91st day old. */
export const HTML_FIXTURE_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// The refresh script writes exactly `YYYY-MM-DDTHH:MM:SSZ`. `Date.parse` also
// accepts `2026-08-09` and locale strings, which would silently move the age
// arithmetic onto a local-midnight guess, so the shape is pinned here rather
// than trusted to the parser.
const CANONICAL_CAPTURE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type HtmlFixtureAgeVerdict =
  | "fresh"
  | "archived"
  | "stale"
  | "future"
  | "missing-captured-at"
  | "unparsable-captured-at";

export interface HtmlFixtureAgeFinding {
  readonly fixture: string;
  readonly verdict: HtmlFixtureAgeVerdict;
  readonly capturedAt: string | null;
  /** Whole days between the capture and `now`; negative for future captures. */
  readonly ageDays: number | null;
  /** Populated exactly when the verdict is a violation. */
  readonly violation: string | null;
}

export interface HtmlFixtureAgeReport {
  readonly findings: readonly HtmlFixtureAgeFinding[];
  readonly violations: readonly string[];
  readonly checkedCount: number;
  readonly failed: boolean;
}

function inspectCapture(
  capture: HtmlFixtureCapture,
  now: Date,
  maxAgeDays: number,
): HtmlFixtureAgeFinding {
  const archived = capture.archivedReason !== null;
  const base = { fixture: capture.fixture, capturedAt: capture.capturedAt };

  if (capture.capturedAt === null) {
    // An archived fixture states its own provenance in the archived reason;
    // a live one has no other record of when its markup was true.
    return archived
      ? { ...base, verdict: "archived", ageDays: null, violation: null }
      : {
          ...base,
          verdict: "missing-captured-at",
          ageDays: null,
          violation: `${capture.fixture}: missing captured-at header`,
        };
  }

  if (!CANONICAL_CAPTURE_RE.test(capture.capturedAt)) {
    return {
      ...base,
      verdict: "unparsable-captured-at",
      ageDays: null,
      violation:
        `${capture.fixture}: captured-at ${capture.capturedAt} is not a canonical UTC ` +
        `capture stamp (YYYY-MM-DDTHH:MM:SSZ)`,
    };
  }

  const capturedAtMs = Date.parse(capture.capturedAt);
  if (Number.isNaN(capturedAtMs)) {
    return {
      ...base,
      verdict: "unparsable-captured-at",
      ageDays: null,
      violation: `${capture.fixture}: unparsable captured-at timestamp ${capture.capturedAt}`,
    };
  }

  const ageDays = Math.floor((now.getTime() - capturedAtMs) / DAY_MS);
  if (capturedAtMs > now.getTime()) {
    return {
      ...base,
      verdict: "future",
      ageDays,
      violation:
        `${capture.fixture}: captured-at ${capture.capturedAt} is after now ` +
        `(${now.toISOString()}); a capture cannot postdate the run that reads it`,
    };
  }

  if (archived) return { ...base, verdict: "archived", ageDays, violation: null };

  if (ageDays > maxAgeDays) {
    return {
      ...base,
      verdict: "stale",
      ageDays,
      violation:
        `${capture.fixture}: captured-at ${capture.capturedAt} is ${ageDays} days old ` +
        `(bound ${maxAgeDays})`,
    };
  }

  return { ...base, verdict: "fresh", ageDays, violation: null };
}

/**
 * A refresh target whose file is gone, archived, or hand-trimmed cannot age at
 * all, so a directory scan alone would report it as one fewer file and pass.
 * The scheduled owner therefore checks the exported inventory too.
 */
function inspectRefreshTargets(
  targets: readonly HtmlFixtureRefreshTarget[],
  captures: readonly HtmlFixtureCapture[],
): string[] {
  const byFixture = new Map(captures.map((capture) => [capture.fixture, capture]));
  return targets.flatMap((target) => {
    const capture = byFixture.get(target.fixture);
    if (capture === undefined) {
      return [`${target.fixture}: listed for refresh but missing from the fixtures directory`];
    }
    if (capture.archivedReason !== null) {
      return [`${target.fixture}: archived but still listed for refresh, which would overwrite the frozen capture`];
    }
    if (capture.trimmedReason !== null) {
      return [`${target.fixture}: manually trimmed but still listed for refresh, which would overwrite the trim`];
    }
    return [];
  });
}

export function evaluateHtmlFixtureAges({
  captures,
  now,
  maxAgeDays = HTML_FIXTURE_MAX_AGE_DAYS,
  targets = HTML_FIXTURE_REFRESH_TARGETS,
}: {
  captures: readonly HtmlFixtureCapture[];
  now: Date;
  maxAgeDays?: number;
  targets?: readonly HtmlFixtureRefreshTarget[];
}): HtmlFixtureAgeReport {
  const findings = captures.map((capture) => inspectCapture(capture, now, maxAgeDays));
  const violations = [
    ...findings.flatMap((finding) => (finding.violation === null ? [] : [finding.violation])),
    ...inspectRefreshTargets(targets, captures),
  ];
  return { findings, violations, checkedCount: findings.length, failed: violations.length > 0 };
}

export function runHtmlFixtureAgeCheck({
  captures = readHtmlFixtureCaptures(),
  now = new Date(),
  maxAgeDays = HTML_FIXTURE_MAX_AGE_DAYS,
  targets = HTML_FIXTURE_REFRESH_TARGETS,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  captures?: readonly HtmlFixtureCapture[];
  now?: Date;
  maxAgeDays?: number;
  targets?: readonly HtmlFixtureRefreshTarget[];
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
} = {}): 0 | 1 {
  const report = evaluateHtmlFixtureAges({ captures, now, maxAgeDays, targets });
  return reportViolations({
    label: "check:html-fixture-age",
    heading: "Reserve HTML fixture capture violations",
    violations: report.violations,
    hint:
      "Recapture with `npm run refresh:html-fixtures` and commit the diff, or " +
      "freeze the capture with an `<!-- archived: why it is frozen -->` header.",
    scannedCount: report.checkedCount,
    stdout,
    stderr,
  });
}

runAsCli(import.meta.url, () => runHtmlFixtureAgeCheck());
