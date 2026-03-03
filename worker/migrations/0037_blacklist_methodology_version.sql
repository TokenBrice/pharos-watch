-- Track Blacklist Tracker methodology version per event row.
-- Historical version windows are reconstructed from methodology-impacting commit timestamps.

ALTER TABLE blacklist_events ADD COLUMN methodology_version TEXT NOT NULL DEFAULT '3.1';

-- Reconstructed version windows (Unix UTC):
-- v1.0: < 1770794846
-- v1.1: 1770794846 - 1770795557
-- v1.2: 1770795558 - 1770882142
-- v2.0: 1770882143 - 1771426562
-- v2.1: 1771426563 - 1771432969
-- v2.2: 1771432970 - 1772010211
-- v3.0: 1772010212 - 1772013288
-- v3.1: >= 1772013289

UPDATE blacklist_events SET methodology_version = '1.0' WHERE timestamp < 1770794846;
UPDATE blacklist_events SET methodology_version = '1.1' WHERE timestamp >= 1770794846 AND timestamp < 1770795558;
UPDATE blacklist_events SET methodology_version = '1.2' WHERE timestamp >= 1770795558 AND timestamp < 1770882143;
UPDATE blacklist_events SET methodology_version = '2.0' WHERE timestamp >= 1770882143 AND timestamp < 1771426563;
UPDATE blacklist_events SET methodology_version = '2.1' WHERE timestamp >= 1771426563 AND timestamp < 1771432970;
UPDATE blacklist_events SET methodology_version = '2.2' WHERE timestamp >= 1771432970 AND timestamp < 1772010212;
UPDATE blacklist_events SET methodology_version = '3.0' WHERE timestamp >= 1772010212 AND timestamp < 1772013289;
UPDATE blacklist_events SET methodology_version = '3.1' WHERE timestamp >= 1772013289;
