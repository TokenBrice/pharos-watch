import type { EditorialExtractorKind } from "./editorial-extractors";

export type EditorialSurfaceOwnership = "pharos" | "quoted" | "mixed";
export type EditorialSurfaceTier = "committed-corpus" | "historical-exempt";

export interface EditorialExtractorOptions {
  /** Dot-separated JSON paths or leaf property names selected by the adapter. */
  readonly fields?: readonly string[];
  /** Stable object fields used to form a record selector when an id is absent. */
  readonly identityFields?: readonly string[];
  /** Stable fields deliberately excluded from prose scanning. */
  readonly excludedFields?: Readonly<Record<string, string>>;
  /** Root record strategy for JSON sources without an object-level id. */
  readonly rootRecord?: "id" | "file" | "key";
  /** Restrict the TS adapter to metadata declarations/buildPageMetadata calls. */
  readonly metadataOnly?: boolean;
  /** Additional top-level TS constants whose string values are prose. */
  readonly topLevelNames?: readonly string[];
  /** Proven exceptions applied to every unit from this surface. */
  readonly exemptions?: readonly string[];
}
export interface EditorialSurfaceEntry {
  readonly id: string;
  readonly register: string;
  readonly paths: readonly string[];
  readonly extractor: EditorialExtractorKind;
  readonly ownership: EditorialSurfaceOwnership;
  readonly tier: EditorialSurfaceTier;
  readonly options?: EditorialExtractorOptions;
}

const JSON_PROFILE_PATHS = ["shared/data/stablecoins/coins/*.json"] as const;

/**
 * Every committed prose family is listed once here. Keep this table CI-only:
 * runtime packages must not import scripts/lib/editorial-*.
 */
export const EDITORIAL_SURFACE_REGISTRY: readonly EditorialSurfaceEntry[] = [
  {
    id: "ai-summaries",
    register: "coin-summary",
    paths: ["data/ai-summaries.json"],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "committed-corpus",
    options: { fields: ["*.title", "*.text"], rootRecord: "key" },
  },
  {
    id: "daily-digests",
    register: "daily",
    paths: ["data/digests.json"],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "historical-exempt",
    options: { fields: ["*.title", "*.text", "*.extended"], identityFields: ["date", "digestType"] },
  },
  {
    id: "weekly-digests",
    register: "weekly",
    paths: ["data/digests.json"],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "historical-exempt",
    options: { fields: ["*.title", "*.text", "*.extended"], identityFields: ["date", "digestType"] },
  },
  {
    id: "coin-profile-prose",
    register: "profile-reference",
    paths: [...JSON_PROFILE_PATHS],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "committed-corpus",
    options: { fields: ["oneLiner", "collateral", "pegMechanism", "links.*.label"], rootRecord: "id" },
  },
  {
    id: "pre-launch-records",
    register: "pre-launch",
    paths: [...JSON_PROFILE_PATHS],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["launchPhaseDetail", "milestones.*.title", "milestones.*.description", "featuredContent.*.description"],
      rootRecord: "id",
    },
  },
  {
    id: "notices",
    register: "notice",
    paths: [...JSON_PROFILE_PATHS],
    extractor: "json-fields",
    ownership: "mixed",
    tier: "committed-corpus",
    options: { fields: ["notices.*.title", "notices.*.message"], rootRecord: "id" },
  },
  {
    id: "lifecycle-reasons",
    register: "lifecycle",
    paths: [...JSON_PROFILE_PATHS, "shared/data/stablecoins/listing-decisions.json"],
    extractor: "json-fields",
    ownership: "mixed",
    tier: "committed-corpus",
    options: {
      fields: ["listingStatusReview.reason", "listingDecision.reason", "archiveReason", "freezeReason"],
      identityFields: ["id", "coinId"],
      rootRecord: "id",
    },
  },
  {
    id: "cemetery",
    register: "cemetery",
    paths: ["shared/data/stablecoins/coins/*.json", "shared/data/dead-stablecoins.json"],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["obituary.epitaph", "obituary.obituary", "*.epitaph", "*.obituary"],
      identityFields: ["id", "coinId"],
      rootRecord: "id",
      exemptions: ["literal-cemetery"],
    },
  },
  {
    id: "annotations",
    register: "technical-evidence",
    paths: ["shared/data/annotations/coins/*.json"],
    extractor: "json-fields",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["*.label", "*.note"],
      identityFields: ["date", "kind", "label"],
      rootRecord: "file",
    },
  },
  {
    id: "domain-sidecars",
    register: "technical-evidence",
    paths: ["shared/data/stablecoins/domains/**/*.json"],
    extractor: "json-fields",
    ownership: "mixed",
    tier: "committed-corpus",
    options: {
      fields: [
        "**.summary",
        "**.rationale",
        "**.reviewNote",
        "**.capDescription",
        "**.sourceFreeRationale",
        "**.evidence",
        "**.notes",
        "**.note",
        "**.label",
        "reserves.*.name",
        "custodyProfile.providers.*.name",
      ],
      identityFields: ["id", "key", "slug", "name", "label", "date", "chain", "component", "branch"],
      excludedFields: {
        "mintAuthority.controls.*.label":
          "Identity key: upgradeability.controlRef may resolve this label; changing it can break referential integrity.",
      },
      rootRecord: "file",
    },
  },
  {
    id: "product-changelogs",
    register: "release-note",
    paths: ["src/data/changelogs/*.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["headline", "fieldNotes", "label", "description"],
      identityFields: ["date", "dateRange", "from", "to"],
    },
  },
  {
    id: "methodology-changelogs",
    register: "technical-release-note",
    paths: ["shared/data/methodology-changelogs/**/*.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: { fields: ["title", "summary", "impact"] , identityFields: ["version", "date"] },
  },
  {
    id: "blog-posts",
    register: "long-form",
    paths: ["src/data/blog/posts/**/*.md"],
    extractor: "markdown-body",
    ownership: "pharos",
    tier: "committed-corpus",
  },
  {
    id: "case-studies",
    register: "long-form",
    paths: ["src/lib/case-studies/*.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: [
        "eyebrow",
        "title",
        "subtitle",
        "lead",
        "takeaways",
        "headline",
        "body",
        "heading",
        "paragraphs",
        "watchpoints",
        "caption",
        "metaDescription",
      ],
      identityFields: ["slug", "dateISO", "heading"],
    },
  },
  {
    id: "learn-glossary",
    register: "reference-teaching",
    paths: ["src/lib/glossary-content.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["term", "definition"],
      topLevelNames: ["GLOSSARY_LEAD"],
      identityFields: ["id", "term"],
    },
  },
  {
    id: "learn-mechanisms",
    register: "reference-teaching",
    paths: ["src/lib/mechanism-explainers/*.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["headline", "subtitle", "lead", "title", "body", "whatToWatch", "label", "note", "obituary"],
      identityFields: ["archetype", "name", "coinId", "title"],
    },
  },
  {
    id: "page-metadata",
    register: "page-description",
    paths: ["src/app/**/page.tsx", "src/app/**/page.ts", "src/lib/page-metadata.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: { fields: ["title", "description"], metadataOnly: true },
  },
  {
    id: "about-prose",
    register: "brand",
    paths: ["src/lib/about-*.ts"],
    extractor: "structured-data",
    ownership: "pharos",
    tier: "committed-corpus",
    options: {
      fields: ["title", "body", "description", "question", "answer", "ariaLabel", "lead", "sources"],
      identityFields: ["id", "title", "name"],
    },
  },
  {
    id: "prose-authoring-skills",
    register: "technical-evidence",
    paths: [".codex/skills/**/SKILL.md"],
    extractor: "markdown-body",
    ownership: "mixed",
    tier: "committed-corpus",
  },
] as const;

export const EDITORIAL_SURFACES = EDITORIAL_SURFACE_REGISTRY;
export const EDITORIAL_BASELINE_PATH = "scripts/lib/editorial-baseline.json";
export const EDITORIAL_EXCEPTIONS_PATH = "scripts/lib/editorial-exceptions.json";
export const EDITORIAL_POLICY_TEST_PATH = "scripts/__tests__/editorial-policy.test.ts";

/** The PR lane runs this focused test, not the full-corpus maintenance sweep. */
export const EDITORIAL_POLICY_TEST_COMMAND = Object.freeze({
  name: "test",
  args: [EDITORIAL_POLICY_TEST_PATH],
});

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/** Small glob matcher kept dependency-free for CI path selection. */
export function editorialGlobToRegExp(glob: string): RegExp {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(char);
    }
  }
  return new RegExp(`${expression}$`);
}

export function editorialPathMatches(pattern: string, path: string): boolean {
  return editorialGlobToRegExp(normalizePath(pattern)).test(normalizePath(path));
}

export function findEditorialSurfacesForPath(path: string): readonly EditorialSurfaceEntry[] {
  return EDITORIAL_SURFACE_REGISTRY.filter((surface) => surface.paths.some((pattern) => editorialPathMatches(pattern, path)));
}

export function hasEditorialPolicyImpact(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => {
    const normalized = normalizePath(file);
    return (
      normalized === EDITORIAL_BASELINE_PATH ||
      normalized === EDITORIAL_EXCEPTIONS_PATH ||
      findEditorialSurfacesForPath(normalized).length > 0
    );
  });
}

export function validateEditorialSurfaceRegistry(
  registry: readonly EditorialSurfaceEntry[] = EDITORIAL_SURFACE_REGISTRY,
  knownRegisters?: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const surface of registry) {
    if (!surface.id || ids.has(surface.id)) throw new Error(`[editorial-style] Duplicate or empty surface id: ${surface.id}`);
    ids.add(surface.id);
    if (!surface.register) throw new Error(`[editorial-style] Surface "${surface.id}" has no register.`);
    if (knownRegisters && !knownRegisters.has(surface.register)) {
      throw new Error(`[editorial-style] Surface "${surface.id}" references unknown register "${surface.register}".`);
    }
    if (surface.paths.length === 0) throw new Error(`[editorial-style] Surface "${surface.id}" has no source paths.`);
  }
}
