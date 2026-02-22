-- Add title column to daily_digest (nullable for backward compat with existing rows)
ALTER TABLE daily_digest ADD COLUMN digest_title TEXT;
