-- Track Liquidity Score methodology version per current row and daily snapshot.
-- Historical version windows are reconstructed from methodology-impacting commit timestamps.

ALTER TABLE dex_liquidity ADD COLUMN methodology_version TEXT NOT NULL DEFAULT '3.2';
ALTER TABLE dex_liquidity_history ADD COLUMN methodology_version TEXT NOT NULL DEFAULT '3.2';

-- Reconstructed version windows (Unix UTC):
-- v1.0: < 1771499167
-- v2.0: 1771499167 - 1772035488
-- v2.1: 1772035489 - 1772209767
-- v2.2: 1772209768 - 1772274137
-- v3.0: 1772274138 - 1772316806
-- v3.1: 1772316807 - 1772449219
-- v3.2: >= 1772449220

UPDATE dex_liquidity SET methodology_version = '1.0' WHERE updated_at < 1771499167;
UPDATE dex_liquidity SET methodology_version = '2.0' WHERE updated_at >= 1771499167 AND updated_at < 1772035489;
UPDATE dex_liquidity SET methodology_version = '2.1' WHERE updated_at >= 1772035489 AND updated_at < 1772209768;
UPDATE dex_liquidity SET methodology_version = '2.2' WHERE updated_at >= 1772209768 AND updated_at < 1772274138;
UPDATE dex_liquidity SET methodology_version = '3.0' WHERE updated_at >= 1772274138 AND updated_at < 1772316807;
UPDATE dex_liquidity SET methodology_version = '3.1' WHERE updated_at >= 1772316807 AND updated_at < 1772449220;
UPDATE dex_liquidity SET methodology_version = '3.2' WHERE updated_at >= 1772449220;

UPDATE dex_liquidity_history SET methodology_version = '1.0' WHERE snapshot_date < 1771499167;
UPDATE dex_liquidity_history SET methodology_version = '2.0' WHERE snapshot_date >= 1771499167 AND snapshot_date < 1772035489;
UPDATE dex_liquidity_history SET methodology_version = '2.1' WHERE snapshot_date >= 1772035489 AND snapshot_date < 1772209768;
UPDATE dex_liquidity_history SET methodology_version = '2.2' WHERE snapshot_date >= 1772209768 AND snapshot_date < 1772274138;
UPDATE dex_liquidity_history SET methodology_version = '3.0' WHERE snapshot_date >= 1772274138 AND snapshot_date < 1772316807;
UPDATE dex_liquidity_history SET methodology_version = '3.1' WHERE snapshot_date >= 1772316807 AND snapshot_date < 1772449220;
UPDATE dex_liquidity_history SET methodology_version = '3.2' WHERE snapshot_date >= 1772449220;
