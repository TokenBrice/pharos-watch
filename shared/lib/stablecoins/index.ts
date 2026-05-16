// NOTE: `./registry` is intentionally NOT re-exported here.
//
// The full registry top-level-imports `coins.generated.json` (1.37 MiB) plus
// the Zod schema. Re-exporting it through this barrel pulled the entire
// payload into every client chunk that touched any helper from this module,
// inflating the bundle by ~1.15 MiB twice over.
//
// Use explicit submodule imports:
//   - Server / build-time / worker callers that need the full StablecoinMeta:
//       import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
//   - Client surfaces (slim projection ~280 KiB):
//       import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
export * from "./status";
export * from "./validate-variants";
export * from "./variants";
