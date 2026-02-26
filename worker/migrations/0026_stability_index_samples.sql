CREATE TABLE stability_index_samples (
  stored_at INTEGER PRIMARY KEY,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL
);
