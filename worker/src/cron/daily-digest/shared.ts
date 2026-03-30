export const NON_WEEKLY_DIGEST_SQL_FILTER =
  "digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly'";
