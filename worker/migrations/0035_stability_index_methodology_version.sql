-- Track PSI methodology version per stored sample/snapshot row.
-- Historical values are reconstructed from methodology-impacting commit timestamps.

ALTER TABLE stability_index_samples ADD COLUMN methodology_version TEXT NOT NULL DEFAULT '3.0';
ALTER TABLE stability_index ADD COLUMN methodology_version TEXT NOT NULL DEFAULT '3.0';

-- Reconstructed version windows (Unix UTC):
-- v1.0: < 1772039501
-- v1.1: 1772039501 - 1772057624
-- v1.2: 1772057625 - 1772066099
-- v1.3: 1772066100 - 1772069914
-- v2.0: 1772069915 - 1772186336
-- v2.1: 1772186337 - 1772379887
-- v3.0: >= 1772379888

UPDATE stability_index_samples SET methodology_version = '1.0' WHERE stored_at < 1772039501;
UPDATE stability_index_samples SET methodology_version = '1.1' WHERE stored_at >= 1772039501 AND stored_at < 1772057625;
UPDATE stability_index_samples SET methodology_version = '1.2' WHERE stored_at >= 1772057625 AND stored_at < 1772066100;
UPDATE stability_index_samples SET methodology_version = '1.3' WHERE stored_at >= 1772066100 AND stored_at < 1772069915;
UPDATE stability_index_samples SET methodology_version = '2.0' WHERE stored_at >= 1772069915 AND stored_at < 1772186337;
UPDATE stability_index_samples SET methodology_version = '2.1' WHERE stored_at >= 1772186337 AND stored_at < 1772379888;
UPDATE stability_index_samples SET methodology_version = '3.0' WHERE stored_at >= 1772379888;

UPDATE stability_index SET methodology_version = '1.0' WHERE computed_at < 1772039501;
UPDATE stability_index SET methodology_version = '1.1' WHERE computed_at >= 1772039501 AND computed_at < 1772057625;
UPDATE stability_index SET methodology_version = '1.2' WHERE computed_at >= 1772057625 AND computed_at < 1772066100;
UPDATE stability_index SET methodology_version = '1.3' WHERE computed_at >= 1772066100 AND computed_at < 1772069915;
UPDATE stability_index SET methodology_version = '2.0' WHERE computed_at >= 1772069915 AND computed_at < 1772186337;
UPDATE stability_index SET methodology_version = '2.1' WHERE computed_at >= 1772186337 AND computed_at < 1772379888;
UPDATE stability_index SET methodology_version = '3.0' WHERE computed_at >= 1772379888;
