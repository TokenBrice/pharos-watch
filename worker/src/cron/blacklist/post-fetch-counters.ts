import {
  type BlacklistPostFetchCounters,
  type CurrentBalanceCacheCounters,
  processFetchedBlacklistRows,
} from "./post-fetch";

type SyncBlacklistPostFetchCounters = {
  enrichCounters: BlacklistPostFetchCounters;
  currentBalanceCacheCounters: CurrentBalanceCacheCounters;
};

type ProcessFetchedRowsContext = Parameters<typeof processFetchedBlacklistRows>[0];

function addEnrichCounters(
  target: BlacklistPostFetchCounters,
  source: BlacklistPostFetchCounters,
): void {
  target.attempted += source.attempted;
  target.succeeded += source.succeeded;
  target.failed += source.failed;
}

function addCurrentBalanceCacheCounters(
  target: CurrentBalanceCacheCounters,
  source: CurrentBalanceCacheCounters,
): void {
  target.updated += source.updated;
  target.deleted += source.deleted;
  target.failed += source.failed;
}

export async function processRowsAndAccumulatePostFetchRows(
  context: ProcessFetchedRowsContext,
  counters: SyncBlacklistPostFetchCounters,
): Promise<number> {
  const processed = await processFetchedBlacklistRows(context);

  addEnrichCounters(counters.enrichCounters, processed.enrichCounters);
  addCurrentBalanceCacheCounters(counters.currentBalanceCacheCounters, processed.currentBalanceCacheCounters);

  return processed.insertedRows;
}
