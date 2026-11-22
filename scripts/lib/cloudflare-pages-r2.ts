import { isRecord } from "../../shared/lib/type-guards.ts";

const API_BASE_URL = "https://api.cloudflare.com/client/v4/";
const REQUEST_TIMEOUT_MS = 30_000;

type RequiredR2Bindings = Record<string, string>;
type BucketLifecycle = { enabledObjectDeletionRules: string[] };
type BucketLifecycles = Record<string, BucketLifecycle>;
type PagesR2Manifest = { pages: { project: string; production: { requiredR2Bindings: RequiredR2Bindings } } };

export async function readCloudflareResult(
  fetchImpl: typeof fetch,
  apiToken: string,
  path: string,
  operation: string,
  { allowNotFound = false, allowWorkflowNotFound = false } = {},
): Promise<unknown> {
  const response = await fetchImpl(new URL(path.replace(/^\//, ""), API_BASE_URL), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (allowNotFound && response.status === 404) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned an unparseable response (HTTP ${response.status})`);
  }
  if (allowWorkflowNotFound && response.status === 404 && isRecord(payload) && payload.success === false
    && Array.isArray(payload.errors)
    && payload.errors.some((error) => isRecord(error) && error.code === 10200
      && error.message === "workflows.api.error.workflow.not_found")) return null;
  const errors = isRecord(payload) && Array.isArray(payload.errors)
    ? payload.errors.filter(isRecord).map((error) => typeof error.message === "string" ? error.message.trim() : "").filter(Boolean).join("; ")
    : "";
  if (!response.ok || !isRecord(payload) || payload.success !== true) {
    throw new Error(`${operation} failed (HTTP ${response.status})${errors ? `: ${errors}` : ""}`);
  }
  if (allowWorkflowNotFound && !isRecord(payload.result)) {
    throw new Error(`${operation} returned a malformed named resource.`);
  }
  return payload.result;
}

export function normalizePagesR2Bindings(production: unknown): RequiredR2Bindings {
  if (!isRecord(production)) return {};
  const bindings: RequiredR2Bindings = {};
  if (isRecord(production.r2_buckets)) {
    for (const [name, bucket] of Object.entries(production.r2_buckets)) {
      bindings[name] = isRecord(bucket) && typeof bucket.name === "string" ? bucket.name.trim() : "";
    }
  }
  if (Array.isArray(production.bindings)) {
    for (const binding of production.bindings) {
      if (isRecord(binding) && binding.type === "r2_bucket" && typeof binding.name === "string") {
        bindings[binding.name] = typeof binding.bucket_name === "string" ? binding.bucket_name.trim() : "";
      }
    }
  }
  return bindings;
}

function validLifecycleCondition(value: unknown, allowDate: boolean): boolean {
  return isRecord(value) && (value.type === "Age"
    ? typeof value.maxAge === "number" && Number.isFinite(value.maxAge) && value.maxAge >= 0
    : allowDate && value.type === "Date" && typeof value.date === "string" && Number.isFinite(Date.parse(value.date)));
}

function validLifecycleTransition(value: unknown, allowDate: boolean): boolean {
  return isRecord(value) && (!Object.hasOwn(value, "condition") || validLifecycleCondition(value.condition, allowDate));
}

// Provider schema: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/
function normalizeR2BucketLifecycle(result: unknown, bucket: string): BucketLifecycle {
  const malformed = `Cloudflare R2 bucket ${bucket} lifecycle lookup returned malformed lifecycle rules.`;
  if (!isRecord(result)) throw new Error(malformed);
  const rules = Object.hasOwn(result, "rules") ? result.rules : [];
  if (!Array.isArray(rules)) throw new Error(malformed);
  const enabledObjectDeletionRules: string[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.id !== "string" || !rule.id.trim() || typeof rule.enabled !== "boolean"
      || !isRecord(rule.conditions) || (Object.hasOwn(rule.conditions, "prefix") && typeof rule.conditions.prefix !== "string")
      || (Object.hasOwn(rule, "deleteObjectsTransition") && !validLifecycleTransition(rule.deleteObjectsTransition, true))
      || (Object.hasOwn(rule, "abortMultipartUploadsTransition") && !validLifecycleTransition(rule.abortMultipartUploadsTransition, false))
      || (Object.hasOwn(rule, "storageClassTransitions") && (!Array.isArray(rule.storageClassTransitions)
        || rule.storageClassTransitions.some((transition) => !isRecord(transition) || transition.storageClass !== "InfrequentAccess"
          || !validLifecycleCondition(transition.condition, true))))) throw new Error(malformed);
    if (rule.enabled && Object.hasOwn(rule, "deleteObjectsTransition")) enabledObjectDeletionRules.push(rule.id);
  }
  return { enabledObjectDeletionRules };
}

export async function fetchRequiredR2BucketLifecycles({
  accountId, requiredR2Bindings, apiToken, fetchImpl = fetch,
}: { accountId: string; requiredR2Bindings: RequiredR2Bindings; apiToken: string; fetchImpl?: typeof fetch }): Promise<BucketLifecycles> {
  const buckets = [...new Set(Object.values(requiredR2Bindings))];
  const entries = await Promise.all(buckets.map(async (bucket) => {
    const result = await readCloudflareResult(fetchImpl, apiToken,
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`,
      `Cloudflare R2 bucket ${bucket} lifecycle lookup`);
    return [bucket, normalizeR2BucketLifecycle(result, bucket)] as const;
  }));
  return Object.fromEntries(entries);
}

export function comparePagesR2Storage(requiredR2Bindings: RequiredR2Bindings, bindings: unknown, lifecycles: unknown): string[] {
  const drift: string[] = [];
  for (const [name, bucket] of Object.entries(requiredR2Bindings)) {
    const actual = isRecord(bindings) ? bindings[name] : undefined;
    if (actual !== bucket) {
      drift.push(`pages.production.r2Bindings.${name}: expected ${JSON.stringify(bucket)}, found ${JSON.stringify(actual)}`);
    }
  }
  for (const bucket of new Set(Object.values(requiredR2Bindings))) {
    const lifecycle = isRecord(lifecycles) ? lifecycles[bucket] : undefined;
    if (!isRecord(lifecycle) || !Array.isArray(lifecycle.enabledObjectDeletionRules)
      || lifecycle.enabledObjectDeletionRules.some((id) => typeof id !== "string" || !id.trim())) {
      drift.push(`r2.buckets.${bucket}.lifecycle: unreadable`);
      continue;
    }
    for (const id of lifecycle.enabledObjectDeletionRules) {
      drift.push(`r2.buckets.${bucket}.lifecycle: enabled object deletion rule ${JSON.stringify(id)} is forbidden`);
    }
  }
  return drift;
}

export async function preflightCloudflarePagesR2({
  manifest, accountId, apiToken, fetchImpl = fetch,
}: { manifest: PagesR2Manifest; accountId?: string; apiToken?: string; fetchImpl?: typeof fetch }): Promise<void> {
  if (!accountId?.trim()) throw new Error("CLOUDFLARE_ACCOUNT_ID is required for the social preview configuration preflight.");
  if (!apiToken?.trim()) throw new Error("CLOUDFLARE_API_TOKEN is required with Pages project and R2 bucket lifecycle read access.");
  const trimmedAccountId = accountId.trim();
  const requiredR2Bindings = manifest.pages.production.requiredR2Bindings;
  const [project, lifecycles] = await Promise.all([
    readCloudflareResult(fetchImpl, apiToken,
      `/accounts/${encodeURIComponent(trimmedAccountId)}/pages/projects/${encodeURIComponent(manifest.pages.project)}`,
      "Cloudflare Pages project lookup"),
    fetchRequiredR2BucketLifecycles({ accountId: trimmedAccountId, requiredR2Bindings, apiToken, fetchImpl }),
  ]);
  if (!isRecord(project) || project.name !== manifest.pages.project || !isRecord(project.deployment_configs)
    || !isRecord(project.deployment_configs.production)) throw new Error("Cloudflare Pages project lookup returned a malformed production project.");
  const drift = comparePagesR2Storage(requiredR2Bindings, normalizePagesR2Bindings(project.deployment_configs.production), lifecycles);
  if (drift.length > 0) throw new Error(`Social preview configuration preflight failed:\n${drift.join("\n")}`);
}
