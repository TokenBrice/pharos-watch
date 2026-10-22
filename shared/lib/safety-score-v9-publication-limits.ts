// Shared by the canonical writer, bounded reader and offline resource report.
// Raw card detail is independent of the compressed/stored transport ceilings.
// Writers may use the expanded ceiling only after every reader is live.
export const SAFETY_SCORE_V9_PUBLICATION_MAX_READ_COMPRESSED_BYTES = 1_400_000;
export const SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_COMPRESSED_BYTES = 1_400_000;

// Owner-approved raw-only increase (2026-10-21); measured basis:
// agents/2026-10-20-safety-refinement/results/SIZE-CHECK.md.
export const SAFETY_SCORE_V9_PUBLICATION_MAX_UNCOMPRESSED_BYTES = 9_200_000;
