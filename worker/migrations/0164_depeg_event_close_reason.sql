-- rollout-safety: backward-compatible
-- 0164: Classify why a live depeg row was closed so downstream dispatch does
-- not treat coverage-loss or superseded rows as price recoveries.

ALTER TABLE depeg_events ADD COLUMN close_reason TEXT;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_close_reason_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.close_reason IS NOT NULL
 AND NEW.close_reason NOT IN (
   'recovered-primary',
   'recovered-dex',
   'recovered-native',
   'coverage-lost-supply',
   'superseded-direction',
   'orphan-tracking-removed'
 )
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.close_reason is invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_close_reason_update
BEFORE UPDATE OF close_reason ON depeg_events
FOR EACH ROW
WHEN NEW.close_reason IS NOT NULL
 AND NEW.close_reason NOT IN (
   'recovered-primary',
   'recovered-dex',
   'recovered-native',
   'coverage-lost-supply',
   'superseded-direction',
   'orphan-tracking-removed'
 )
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.close_reason is invalid');
END;
