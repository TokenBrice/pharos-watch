-- DB-level guards for enum-like fields and basic non-negativity invariants.
-- Uses triggers to avoid destructive table rebuilds on existing data.

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_direction_update
BEFORE UPDATE OF direction ON depeg_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_insert
BEFORE INSERT ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_events_source_update
BEFORE UPDATE OF source ON depeg_events
FOR EACH ROW
WHEN NEW.source NOT IN ('live', 'backfill')
BEGIN
  SELECT RAISE(ABORT, 'depeg_events.source must be live|backfill');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_insert
BEFORE INSERT ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_depeg_pending_direction_update
BEFORE UPDATE OF direction ON depeg_pending
FOR EACH ROW
WHEN NEW.direction NOT IN ('above', 'below')
BEGIN
  SELECT RAISE(ABORT, 'depeg_pending.direction must be above|below');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_direction_update
BEFORE UPDATE OF direction ON mint_burn_events
FOR EACH ROW
WHEN NEW.direction NOT IN ('mint', 'burn')
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events.direction must be mint|burn');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_insert
BEFORE INSERT ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_mint_burn_events_amount_update
BEFORE UPDATE OF amount, amount_usd ON mint_burn_events
FOR EACH ROW
WHEN NEW.amount < 0 OR (NEW.amount_usd IS NOT NULL AND NEW.amount_usd < 0)
BEGIN
  SELECT RAISE(ABORT, 'mint_burn_events amounts must be non-negative');
END;
