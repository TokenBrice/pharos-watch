# Worker Telegram Agent Notes

Applies to `worker/src/telegram/` and its integration with `worker/src/cron/telegram/`.

## Public Entries

- Preserve the existing seam owners and dependency directions in `docs/telegram-architecture.md#seam-overview`.
- External Worker consumers may import only exact entry modules allowed for their importer by `scripts/ci/check-architecture-boundaries.ts`; internal core/cron imports do not grant unrelated features a deep-import exemption. Follow `docs/telegram-architecture.md#structural-change-policy`.
- Import implementations directly. Do not add compatibility barrels, old-location re-exports, or an export-everything feature index.
- Shared contracts, Mini App UI, and the adoption proxy remain outside Worker implementation; they must not acquire production imports into this subtree.

## Role Boundaries

- Keep scheduler implementation in `worker/src/cron/telegram/` and registered route/scheduled adapters with their existing owners; moving a module does not change its role.
- Preserve the Public/Heavy boundary: HTTP-bearing Telegram modules must not become reachable from Heavy. Generic transport and outbox are not blanket HTTP exclusions; retain their precise public entries and the single Bot API transport owner in `docs/telegram-architecture.md#8-outbound-transport`.
- Update exact public-entry pairs and role guards atomically with a path change, as required by `docs/telegram-architecture.md#structural-change-policy`.
