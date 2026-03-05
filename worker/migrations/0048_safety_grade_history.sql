CREATE TABLE safety_grade_history (
  stablecoin_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  grade TEXT NOT NULL,
  score REAL,
  prev_grade TEXT,
  prev_score REAL,
  methodology_version TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, recorded_at),
  CHECK (grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (prev_grade IS NULL OR prev_grade IN ('A+','A','A-','B+','B','B-','C+','C','C-','D','F','NR')),
  CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CHECK (prev_score IS NULL OR (prev_score >= 0 AND prev_score <= 100))
);

CREATE INDEX idx_safety_grade_history_coin
  ON safety_grade_history(stablecoin_id, recorded_at DESC);

CREATE INDEX idx_safety_grade_history_recorded_at
  ON safety_grade_history(recorded_at DESC);
