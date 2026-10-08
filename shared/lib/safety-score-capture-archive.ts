// The existing pharos-measurements captures/ lifecycle owns R2 object expiry.
// Daily Worker housekeeping applies the same window to the narrow D1 index.
export const SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC = 180 * 86_400;
