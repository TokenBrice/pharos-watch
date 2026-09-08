export function publishedYieldCache(updatedAt: number, rankings: unknown[] = [], generationId = "yield-published") {
  return {
    key: "yield-rankings",
    value: JSON.stringify({
      updatedAt,
      publication: { generationId, updatedAt, cutoffAt: updatedAt, schemaVersion: 1, status: "published" },
      rankings,
    }),
    updated_at: updatedAt,
  };
}
