-- data-migration: reviewed
-- rollout-safety: backward-compatible
CREATE TABLE mint_burn_writer_epoch_coverage (
  config_key TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
  chain_id TEXT NOT NULL, stablecoin_id TEXT NOT NULL, writer_epoch TEXT NOT NULL,
  from_block INTEGER NOT NULL, to_block INTEGER NOT NULL,
  from_timestamp INTEGER NOT NULL, to_timestamp INTEGER NOT NULL,
  PRIMARY KEY (config_key, config_fingerprint, writer_epoch, from_block)
);
CREATE INDEX idx_mint_burn_writer_epoch_invalidation ON mint_burn_writer_epoch_coverage
  (stablecoin_id, chain_id, from_timestamp, to_timestamp);

-- A legacy write leaves its exact bucket unverified, even before scan proof exists.
CREATE TABLE mint_burn_writer_epoch_hours (
  stablecoin_id TEXT NOT NULL, chain_id TEXT NOT NULL, hour_ts INTEGER NOT NULL,
  writer_epoch TEXT, revision TEXT,
  PRIMARY KEY (stablecoin_id, chain_id, hour_ts)
) WITHOUT ROWID;

CREATE TRIGGER trg_mint_burn_epoch_dirty_hours_insert AFTER INSERT ON mint_burn_dirty_hours
BEGIN
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (NEW.stablecoin_id, NEW.chain_id, NEW.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
END;

CREATE TRIGGER trg_mint_burn_epoch_dirty_hours_update AFTER UPDATE ON mint_burn_dirty_hours
BEGIN
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (OLD.stablecoin_id, OLD.chain_id, OLD.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (NEW.stablecoin_id, NEW.chain_id, NEW.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
END;

CREATE TRIGGER trg_mint_burn_epoch_hourly_insert AFTER INSERT ON mint_burn_hourly
BEGIN
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (NEW.stablecoin_id, NEW.chain_id, NEW.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
END;

CREATE TRIGGER trg_mint_burn_epoch_hourly_update AFTER UPDATE ON mint_burn_hourly
BEGIN
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (OLD.stablecoin_id, OLD.chain_id, OLD.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (NEW.stablecoin_id, NEW.chain_id, NEW.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
END;

CREATE TRIGGER trg_mint_burn_epoch_hourly_delete AFTER DELETE ON mint_burn_hourly
BEGIN
  INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts)
    VALUES (OLD.stablecoin_id, OLD.chain_id, OLD.hour_ts)
    ON CONFLICT(stablecoin_id, chain_id, hour_ts) DO UPDATE SET writer_epoch = NULL, revision = NULL;
END;
