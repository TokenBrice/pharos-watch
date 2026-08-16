import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, resolve } from "node:path";
import type { StablecoinMeta } from "@shared/types";
import {
  STABLECOIN_SOURCE_DOMAIN_FIELDS,
  STABLECOIN_SOURCE_DOMAIN_SCHEMAS,
  STABLECOIN_SOURCE_DOMAIN_VALUES,
  StablecoinMetaAssetSchema,
  StablecoinMetaSourceAssetSchema,
  type StablecoinSourceDomain,
} from "@shared/lib/stablecoins/schema";
import {
  PER_COIN_SOURCE_DIR,
  STABLECOIN_DOMAIN_SOURCE_DIR,
} from "./stablecoin-catalog-sources";

export interface StablecoinSidecarMigrationOptions {
  check?: boolean;
  domain: StablecoinSourceDomain;
  dryRun?: boolean;
  id: string;
  rootDir?: string;
}

export interface StablecoinSidecarMigrationResult {
  baseFile: string;
  changed: boolean;
  domain: StablecoinSourceDomain;
  dryRun: boolean;
  id: string;
  movedFields: Array<keyof StablecoinMeta>;
  sidecarFile: string;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonObject(relativePath: string, rootDir: string): Record<string, unknown> {
  const absolutePath = resolve(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${relativePath} does not exist`);
  }
  // Repo-owned workflow reads only canonical catalog paths assembled from validated CLI identifiers.
  const value = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain one JSON object`);
  }
  return value as Record<string, unknown>;
}

function hasOwnField(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function formatSchemaError(relativePath: string, issues: Array<{ message: string; path: PropertyKey[] }>): Error {
  const summary = issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  return new Error(`${relativePath} is invalid: ${summary}`);
}

/**
 * Fields the coin already keeps in *other* domains' sidecars. The projection-equality check
 * below parses against the full catalog schema, whose cross-field refinements span domains
 * (a `liveReservesConfig` in the base file is validated against a `reserves` slice that may
 * already live in the reserves sidecar). Without this overlay the check would compare two
 * equally incomplete projections and fail closed on every coin that is already partly migrated.
 */
function readOtherDomainOverlay(
  id: string,
  domain: StablecoinSourceDomain,
  rootDir: string,
): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  for (const otherDomain of STABLECOIN_SOURCE_DOMAIN_VALUES) {
    if (otherDomain === domain) continue;
    const path = `${STABLECOIN_DOMAIN_SOURCE_DIR}/${otherDomain}/${id}.json`;
    if (!existsSync(resolve(rootDir, path))) continue;
    const raw = readJsonObject(path, rootDir);
    for (const field of STABLECOIN_SOURCE_DOMAIN_FIELDS[otherDomain]) {
      if (hasOwnField(raw, field)) overlay[field] = raw[field];
    }
  }
  return overlay;
}

export function migrateStablecoinSidecar(
  options: StablecoinSidecarMigrationOptions,
): StablecoinSidecarMigrationResult {
  const rootDir = options.rootDir ?? process.cwd();
  const baseFile = `${PER_COIN_SOURCE_DIR}/${options.id}.json`;
  const sidecarFile = `${STABLECOIN_DOMAIN_SOURCE_DIR}/${options.domain}/${options.id}.json`;
  const baseRaw = readJsonObject(baseFile, rootDir);
  const parsedBase = StablecoinMetaSourceAssetSchema.safeParse(baseRaw);
  if (!parsedBase.success) {
    throw formatSchemaError(baseFile, parsedBase.error.issues);
  }
  if (parsedBase.data.id !== options.id) {
    throw new Error(`${baseFile} contains id "${parsedBase.data.id}", expected "${options.id}"`);
  }

  const domainFields = STABLECOIN_SOURCE_DOMAIN_FIELDS[options.domain];
  const domainFieldNames = new Set<string>(domainFields);
  const movedFields = domainFields.filter((field) => hasOwnField(baseRaw, field));
  const sidecarExists = existsSync(resolve(rootDir, sidecarFile));

  if (movedFields.length === 0) {
    if (!sidecarExists) {
      throw new Error(`${baseFile} has no ${options.domain} fields and ${sidecarFile} does not exist`);
    }
    const parsedSidecar = STABLECOIN_SOURCE_DOMAIN_SCHEMAS[options.domain].safeParse(
      readJsonObject(sidecarFile, rootDir),
    );
    if (!parsedSidecar.success) {
      throw formatSchemaError(sidecarFile, parsedSidecar.error.issues);
    }
    if ((parsedSidecar.data as { id: string }).id !== options.id) {
      throw new Error(
        `${sidecarFile} contains id "${(parsedSidecar.data as { id: string }).id}", expected "${options.id}"`,
      );
    }
    return {
      baseFile,
      changed: false,
      domain: options.domain,
      dryRun: options.dryRun === true,
      id: options.id,
      movedFields: [],
      sidecarFile,
    };
  }

  if (options.check) {
    throw new Error(
      `${baseFile} still contains ${options.domain} fields: ${movedFields.join(", ")}`,
    );
  }
  if (sidecarExists) {
    throw new Error(
      `${sidecarFile} already exists while ${baseFile} still contains ${options.domain} fields; ` +
      "resolve the partial migration explicitly",
    );
  }

  const sidecar: Record<string, unknown> = { id: options.id };
  for (const field of domainFields) {
    if (hasOwnField(baseRaw, field)) {
      sidecar[field] = baseRaw[field];
    }
  }
  const parsedSidecar = STABLECOIN_SOURCE_DOMAIN_SCHEMAS[options.domain].safeParse(sidecar);
  if (!parsedSidecar.success) {
    throw formatSchemaError(sidecarFile, parsedSidecar.error.issues);
  }

  const nextBase = Object.fromEntries(
    Object.entries(baseRaw).filter(([field]) => !domainFieldNames.has(field)),
  );
  const parsedNextBase = StablecoinMetaSourceAssetSchema.safeParse(nextBase);
  if (!parsedNextBase.success) {
    throw formatSchemaError(baseFile, parsedNextBase.error.issues);
  }

  const overlay = readOtherDomainOverlay(options.id, options.domain, rootDir);
  const merged = StablecoinMetaAssetSchema.safeParse({
    ...nextBase,
    ...overlay,
    ...Object.fromEntries(movedFields.map((field) => [field, sidecar[field]])),
  });
  if (!merged.success) {
    throw formatSchemaError(`${baseFile} + ${sidecarFile}`, merged.error.issues);
  }
  const original = StablecoinMetaAssetSchema.safeParse({ ...baseRaw, ...overlay });
  if (!original.success) {
    throw formatSchemaError(baseFile, original.error.issues);
  }
  if (!isDeepStrictEqual(original.data, merged.data)) {
    throw new Error(`${options.id}: merged projection changed during ${options.domain} migration`);
  }

  if (!options.dryRun) {
    const absoluteSidecar = resolve(rootDir, sidecarFile);
    // Repo-owned workflow writes only canonical catalog paths assembled from validated IDs/domains.
    mkdirSync(dirname(absoluteSidecar), { recursive: true });
    // Repo-owned workflow writes only canonical catalog paths assembled from validated IDs/domains.
    writeFileSync(absoluteSidecar, formatJson(sidecar), "utf8");
    // Write the stripped base last so an interrupted migration fails closed on duplicate ownership.
    writeFileSync(resolve(rootDir, baseFile), formatJson(nextBase), "utf8");
  }

  return {
    baseFile,
    changed: true,
    domain: options.domain,
    dryRun: options.dryRun === true,
    id: options.id,
    movedFields: [...movedFields],
    sidecarFile,
  };
}
