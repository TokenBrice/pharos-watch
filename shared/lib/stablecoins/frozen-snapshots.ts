import { z } from "zod";
import frozenSnapshotsAsset from "../../data/stablecoins/frozen-snapshots.json";

/**
 * A frozen coin's last-known DefiLlama `peggedAssets` row, captured at the
 * moment of freezing. Injected into the upstream payload by sync-stablecoins
 * intake when DefiLlama no longer returns the asset.
 *
 * peggedAssetRow is intentionally typed as a permissive record — DefiLlama's
 * row shape is wide and partially undocumented; structural validation lives
 * in `filterStructurallyValidAssets`.
 */
export interface FrozenSnapshot {
  id: string;
  capturedAt: string;
  peggedAssetRow: Record<string, unknown> & { id: string };
}

const frozenSnapshotSchema = z
  .object({
    id: z.string().min(1),
    capturedAt: z.string().datetime(),
    peggedAssetRow: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .superRefine((entry, ctx) => {
    if (entry.peggedAssetRow.id !== entry.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `frozen-snapshots id mismatch: ${entry.id} vs peggedAssetRow.id ${entry.peggedAssetRow.id}`,
        path: ["peggedAssetRow", "id"],
      });
    }
  });

export function parseFrozenSnapshots(input: unknown, source: string): FrozenSnapshot[] {
  const parsed = z.array(frozenSnapshotSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid ${source}: ${parsed.error.message}`);
  }
  return parsed.data as FrozenSnapshot[];
}

export const FROZEN_SNAPSHOTS: FrozenSnapshot[] = parseFrozenSnapshots(
  frozenSnapshotsAsset,
  "shared/data/stablecoins/frozen-snapshots.json",
);

export const FROZEN_SNAPSHOTS_BY_ID = new Map(FROZEN_SNAPSHOTS.map((s) => [s.id, s]));
