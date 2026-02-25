-- Pharos Stability Index: daily score snapshots
CREATE TABLE stability_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL
);
CREATE INDEX idx_stability_index_computed_at ON stability_index(computed_at);
