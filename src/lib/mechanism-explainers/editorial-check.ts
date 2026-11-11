import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getActiveByArchetype } from "@shared/lib/stablecoins/by-mechanism";
import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import { ARCHETYPE_CONTENT } from "./index";

/** The explainer fields the guard reads; the authored modules narrow to these. */
interface MechanismExplainerContent {
  readonly archetype: string;
  readonly representativeCoins: readonly { readonly coinId: string; readonly note: string }[];
  readonly whatToWatch: readonly string[];
}

type MechanismExplainerMeta = Parameters<typeof resolveMechanismArchetype>[0] & {
  readonly pegMechanism?: string | null;
};

interface MechanismExplainerSources {
  readonly archetypes: readonly string[];
  readonly content: Readonly<Record<string, MechanismExplainerContent>>;
  readonly metaById: ReadonlyMap<string, MechanismExplainerMeta>;
  readonly resolveArchetype: (
    coin: MechanismExplainerMeta,
    registry: ReadonlyMap<string, MechanismExplainerMeta>,
  ) => string | null;
  readonly activeNavMembers: readonly unknown[];
}

/**
 * Authored mechanism-explainer prose is content, not runtime code: every
 * representative coin must resolve to its own archetype, DEWS bullets may not
 * promise coverage the engine skips, and the OUSG note may not contradict the
 * reviewed reserve composition it describes.
 *
 * `overrides` exists so the owning test can drive one rule at a time; the guard
 * itself always runs against the authored sources and the real repo files.
 */
export function mechanismExplainerIssues(
  repoRoot: string,
  overrides: Partial<MechanismExplainerSources> = {},
): string[] {
  const sources: MechanismExplainerSources = {
    archetypes: MECHANISM_ARCHETYPE_VALUES,
    content: ARCHETYPE_CONTENT,
    metaById: TRACKED_META_BY_ID,
    resolveArchetype: resolveMechanismArchetype,
    activeNavMembers: getActiveByArchetype("synthetic-delta-neutral").filter((coin) => coin.flags.navToken),
    ...overrides,
  };
  const issues: string[] = [];
  for (const archetype of sources.archetypes) {
    const content = sources.content[archetype];
    if (content.archetype !== archetype) {
      issues.push(`src/lib/mechanism-explainers: ${archetype} content declares archetype ${content.archetype}`);
    }
    for (const entry of content.representativeCoins) {
      const meta = sources.metaById.get(entry.coinId);
      if (!meta) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} representative coin ${entry.coinId} is not tracked`);
        continue;
      }
      const resolved = sources.resolveArchetype(meta, sources.metaById);
      if (resolved !== archetype) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} representative coin ${entry.coinId} resolves to ${resolved}`);
      }
      if (archetype === "rwa-credit-fund" && /quarterly/i.test(entry.note)) {
        const mechanism = (meta.pegMechanism ?? "").toLowerCase();
        if (!mechanism.includes("quarter")) {
          issues.push(`src/lib/mechanism-explainers: ${entry.coinId} claims quarterly redemptions without a reviewed quarterly mechanism`);
        }
      }
    }
    for (const bullet of content.whatToWatch.filter((entry) => /DEWS/.test(entry))) {
      if (/full[^.]*coverage/i.test(bullet)) {
        issues.push(`src/lib/mechanism-explainers: ${archetype} DEWS bullet claims full coverage: ${bullet}`);
      }
    }
  }

  // NAV wrappers are not scored by DEWS, so its bullet must name that exception.
  if (sources.activeNavMembers.length === 0) {
    issues.push("src/lib/mechanism-explainers: synthetic-delta-neutral has no active NAV wrapper to qualify DEWS coverage");
  }
  const navDewsBullets = sources.content["synthetic-delta-neutral"].whatToWatch.filter((bullet) => /DEWS/.test(bullet));
  if (navDewsBullets.length === 0) {
    issues.push("src/lib/mechanism-explainers: synthetic-delta-neutral DEWS bullet no longer names the NAV exception");
  }
  for (const bullet of navDewsBullets) {
    if (/full/i.test(bullet) || !/NAV/.test(bullet)) {
      issues.push(`src/lib/mechanism-explainers: synthetic-delta-neutral DEWS bullet overstates coverage: ${bullet}`);
    }
  }

  const ousgNote = sources.content.tbill.representativeCoins.find((entry) => entry.coinId === "ousg-ondo-finance")?.note;
  if (!ousgNote) {
    issues.push("src/lib/mechanism-explainers: tbill OUSG example is missing its note");
  } else {
    try {
      const { reserves } = JSON.parse(
        readFileSync(join(repoRoot, "shared/data/stablecoins/domains/reserves/ousg-ondo-finance.json"), "utf8"),
      ) as { reserves: Array<{ name: string; pct: number }> };
      const topReserve = [...reserves].sort((left, right) => right.pct - left.pct)[0]?.name ?? "";
      if (!topReserve.includes("State Street")) {
        issues.push(`src/lib/mechanism-explainers: OUSG reviewed reserves no longer lead with State Street (${topReserve})`);
      }
    } catch (error) {
      issues.push(`shared/data/stablecoins/domains/reserves/ousg-ondo-finance.json: ${String(error)}`);
    }
    if (/mostly BUIDL|FedFund/i.test(ousgNote)) {
      issues.push("src/lib/mechanism-explainers: OUSG note names a reserve mix its reviewed composition contradicts");
    }
    if (!ousgNote.includes("OUSGInstantManager")) {
      issues.push("src/lib/mechanism-explainers: OUSG note no longer names the OUSGInstantManager route");
    }
  }
  return issues;
}

