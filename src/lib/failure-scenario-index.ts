import "server-only";

import failureScenarios from "@data/failure-scenarios.json";
import { selectFailureScenario } from "@shared/lib/failure-scenarios";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { isActiveStablecoinMeta, isFrozenStablecoinMeta } from "@shared/lib/stablecoins/status";
import type { FailureScenario, FailureScenariosById } from "@shared/types/failure-scenarios";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

/**
 * Server-only index of published failure scenarios.
 *
 * NEVER import this module from a `"use client"` component: it reads the full
 * `data/failure-scenarios.json` corpus together with schema validation and
 * SHA-256 content-binding helpers. Pass only bounded scalar lists (such as
 * `PUBLISHED_FAILURE_SCENARIO_IDS`) across a server-to-client boundary.
 */

const typedFailureScenarios = failureScenarios as FailureScenariosById;

type ApprovedFailureScenarioReview = Extract<FailureScenario["review"], { status: "approved" }>;

export interface PublishedFailureScenario {
  readonly id: string;
  readonly coin: StablecoinMeta;
  readonly scenario: FailureScenario;
  readonly reviewedAt: string;
}

export function selectPublishedFailureScenarios(
  all: FailureScenariosById = typedFailureScenarios,
  now: Date = new Date(),
): readonly PublishedFailureScenario[] {
  const published: PublishedFailureScenario[] = [];
  for (const coin of TRACKED_STABLECOINS) {
    // Match `src/app/stablecoin/[id]/page.tsx`: pre-launch, quarantined, and
    // delisted routes return early and never render `#how-it-breaks`.
    if (!isActiveStablecoinMeta(coin) && !isFrozenStablecoinMeta(coin)) continue;
    if (!Object.hasOwn(all, coin.id)) continue;
    const selection = selectFailureScenario(all, coin.id, { allowDrafts: false, now });
    if (!selection) continue;
    // `allowDrafts: false` guarantees `review.status === "approved"`.
    const review = selection.scenario.review as ApprovedFailureScenarioReview;
    published.push({
      id: coin.id,
      coin,
      scenario: selection.scenario,
      reviewedAt: review.reviewedAt,
    });
  }
  return published;
}

export const PUBLISHED_FAILURE_SCENARIOS: readonly PublishedFailureScenario[] =
  selectPublishedFailureScenarios(typedFailureScenarios);

export const PUBLISHED_FAILURE_SCENARIO_IDS: readonly string[] =
  PUBLISHED_FAILURE_SCENARIOS.map((entry) => entry.id);
