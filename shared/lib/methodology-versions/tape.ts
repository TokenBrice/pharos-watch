/**
 * Version label shown on the /tape/ status badge. Bumps when
 * `TAPE_PROJECTOR_JOBS` in `worker/src/cron/project-tape.ts` changes
 * meaningfully — a new class ships, the projector contract changes, or the
 * `tape_events` schema bumps. Independent of methodology routes; /tape has
 * no methodology page of its own yet.
 *
 * Numeric progression (project rule): v1 → v1.1 → v1.91 → v2.0 (never v1.10).
 */
export const TAPE_PROJECTOR_VERSION_LABEL = "v1";
