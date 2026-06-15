// Shared primitives for the homepage bootstrap payload, used by both the
// build-time module (homepage-bootstrap.ts, Zod-validating) and the
// browser-runtime module (homepage-bootstrap-runtime.ts, Zod-free to keep Zod
// out of the inline-hydration bundle). Keep value/version logic here so the two
// modules can never drift — a one-sided HOMEPAGE_BOOTSTRAP_VERSION bump would
// otherwise silently reject all bootstrap payloads at runtime.

/** Payload schema version. Bump in lockstep with the generator. */
export const HOMEPAGE_BOOTSTRAP_VERSION = 1;

export function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeSource(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function queryUpdatedAtMs(fetchedAt: number): number {
  return fetchedAt < 10_000_000_000 ? fetchedAt * 1000 : fetchedAt;
}

/** Minimal descriptor shape needed for seedability math; both the build-time
 *  and runtime FrontendApiQueryDescriptor variants satisfy it structurally. */
interface SeedableDescriptor {
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
}

export function descriptorMaxAgeMs(descriptor: SeedableDescriptor): number {
  return (descriptor.metaMaxAgeSec ?? descriptor.producerIntervalMs / 1000) * 1000;
}

export function isSeedableQuery(
  query: { fetchedAt: number },
  descriptor: SeedableDescriptor,
  nowMs: number,
): boolean {
  return nowMs - queryUpdatedAtMs(query.fetchedAt) <= descriptorMaxAgeMs(descriptor);
}
