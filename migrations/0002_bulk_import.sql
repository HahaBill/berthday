-- Resumable, append-only workbook imports. Staging never changes the schedule.
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','ready','importing','completed','cancelled')),
  file_count INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  imported_reservations INTEGER NOT NULL DEFAULT 0,
  imported_vessels INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  date_from TEXT,
  date_to TEXT,
  commit_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_import_jobs_created ON import_jobs (created_at, id);

CREATE TABLE import_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  imported_reservations INTEGER NOT NULL DEFAULT 0,
  imported_vessels INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staging' CHECK (status IN ('staging','staged','importing','completed','duplicate','cancelled')),
  diagnostics TEXT NOT NULL DEFAULT '[]',
  duplicate_of_file_id TEXT REFERENCES import_files(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, sha256)
);
CREATE INDEX idx_import_files_job ON import_files (job_id, created_at, id);
CREATE INDEX idx_import_files_hash ON import_files (sha256, status);

CREATE TABLE import_rows (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  file_id TEXT NOT NULL REFERENCES import_files(id),
  row_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  payload TEXT,
  validation_error TEXT,
  record_type TEXT,
  kind TEXT,
  berth_id TEXT,
  vessel_name TEXT,
  vessel_key TEXT,
  vessel_length_ft INTEGER,
  vessel_length_status TEXT,
  vessel_length_note TEXT,
  generated_vessel_id TEXT,
  resolved_vessel_id TEXT,
  generated_reservation_id TEXT,
  title TEXT,
  normalized_title TEXT,
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','imported','duplicate','invalid')),
  stage_token TEXT NOT NULL,
  commit_token TEXT,
  processed_at TEXT,
  UNIQUE (file_id, row_index)
);
CREATE INDEX idx_import_rows_pending ON import_rows (job_id, status, id);
CREATE INDEX idx_import_rows_stage ON import_rows (stage_token);
CREATE INDEX idx_import_rows_commit ON import_rows (commit_token);

CREATE TABLE import_issue_links (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  file_id TEXT NOT NULL REFERENCES import_files(id),
  commit_token TEXT NOT NULL
);
CREATE INDEX idx_import_issue_links_commit ON import_issue_links (commit_token);

-- A semantic key is independent of workbook names, colors, lanes, and source cells.
-- The same title normalization is applied to existing and imported rows.
CREATE TABLE reservation_import_keys (
  reservation_id TEXT PRIMARY KEY,
  semantic_key TEXT NOT NULL UNIQUE
);
CREATE VIEW reservation_semantic_keys AS
SELECT id AS reservation_id, json_array(berth_id, kind, coalesce(vessel_id, ''),
  CASE WHEN kind = 'vessel' THEN '' ELSE upper(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))) END,
  start_date, end_date) AS semantic_key FROM reservations;
INSERT OR IGNORE INTO reservation_import_keys SELECT reservation_id, semantic_key FROM reservation_semantic_keys;
CREATE TRIGGER reservation_import_key_insert AFTER INSERT ON reservations BEGIN
  INSERT OR IGNORE INTO reservation_import_keys SELECT reservation_id, semantic_key FROM reservation_semantic_keys WHERE reservation_id = NEW.id;
END;
CREATE TRIGGER reservation_import_key_update AFTER UPDATE OF berth_id, kind, vessel_id, title, start_date, end_date ON reservations BEGIN
  UPDATE reservation_import_keys SET reservation_id = (
    SELECT min(s.reservation_id) FROM reservation_semantic_keys s WHERE s.semantic_key = reservation_import_keys.semantic_key AND s.reservation_id <> OLD.id
  ) WHERE reservation_id = OLD.id AND EXISTS (
    SELECT 1 FROM reservation_semantic_keys s WHERE s.semantic_key = reservation_import_keys.semantic_key AND s.reservation_id <> OLD.id
  );
  DELETE FROM reservation_import_keys WHERE reservation_id = OLD.id;
  INSERT OR IGNORE INTO reservation_import_keys SELECT reservation_id, semantic_key FROM reservation_semantic_keys WHERE reservation_id = NEW.id;
END;
CREATE TRIGGER reservation_import_key_delete AFTER DELETE ON reservations BEGIN
  UPDATE reservation_import_keys SET reservation_id = (
    SELECT min(s.reservation_id) FROM reservation_semantic_keys s WHERE s.semantic_key = reservation_import_keys.semantic_key
  ) WHERE reservation_id = OLD.id AND EXISTS (
    SELECT 1 FROM reservation_semantic_keys s WHERE s.semantic_key = reservation_import_keys.semantic_key
  );
  DELETE FROM reservation_import_keys WHERE reservation_id = OLD.id;
END;
