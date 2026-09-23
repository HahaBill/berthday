-- Berthday schema. Dates are ISO 'YYYY-MM-DD' strings; ranges are INCLUSIVE on both ends.
CREATE TABLE berths (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  length_ft INTEGER CHECK (length_ft IS NULL OR length_ft > 0),
  is_exclusive INTEGER NOT NULL DEFAULT 1 CHECK (is_exclusive IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT
);

CREATE TABLE vessels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  length_ft INTEGER CHECK (length_ft IS NULL OR length_ft > 0),
  length_status TEXT NOT NULL CHECK (length_status IN ('known', 'unknown', 'disputed')),
  length_note TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  berth_id TEXT NOT NULL REFERENCES berths(id),
  kind TEXT NOT NULL CHECK (kind IN ('vessel', 'event', 'closure', 'hold')),
  vessel_id TEXT REFERENCES vessels(id),
  title TEXT,
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notes TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('legacy', 'app')),
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date >= start_date),
  CHECK ((kind = 'vessel') = (vessel_id IS NOT NULL)),
  CHECK (kind = 'vessel' OR (title IS NOT NULL AND length(trim(title)) > 0))
);
CREATE INDEX idx_res_berth_start ON reservations (berth_id, start_date);
CREATE INDEX idx_res_start ON reservations (start_date);
CREATE INDEX idx_res_vessel_start ON reservations (vessel_id, start_date);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('overlap', 'fit', 'vessel_double')),
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  other_reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  berth_id TEXT REFERENCES berths(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  details TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_issues_start ON issues (start_date);
CREATE INDEX idx_issues_res ON issues (reservation_id);
CREATE INDEX idx_issues_other ON issues (other_reservation_id);

CREATE TABLE import_issues (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  sheet TEXT,
  cell TEXT,
  message TEXT NOT NULL,
  reservation_id TEXT
);
CREATE INDEX idx_import_issues_code ON import_issues (code);

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
