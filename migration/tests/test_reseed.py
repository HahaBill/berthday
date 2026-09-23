"""Operational seed safeguards added after the original golden migration tests."""
import importlib.util
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("berthday_seed_extractor", ROOT / "migration" / "extract.py")
EXTRACTOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EXTRACTOR
SPEC.loader.exec_module(EXTRACTOR)


def database(path=":memory:"):
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        connection.executescript(migration.read_text())
    return connection


def test_reseed_clears_import_history_and_rebuilds_semantic_keys():
    connection = database()
    data = {
        "berths": [{"id": "seed-berth", "name": "Original berth", "length_ft": 90, "is_exclusive": 1, "sort_order": 0}],
        "vessels": [],
        "reservations": [{"id": "seed-event", "berth_id": "seed-berth", "kind": "event", "title": "Original event", "start_date": "2019-07-01", "end_date": "2019-07-01", "origin": "legacy"}],
        "issues": [], "import_issues": [],
        "summary": {"data_range": {"from": "2019-07-01", "to": "2019-07-01"}, "max_span_days": 1},
    }
    seed = EXTRACTOR.to_sql(data, "2026-09-22T00:00:00+00:00")
    connection.executescript(seed)
    connection.executescript("""
        INSERT INTO berths (id,name) VALUES ('added-berth','Added resource');
        INSERT INTO reservations (id,berth_id,kind,title,start_date,end_date,origin,created_at,updated_at)
            VALUES ('imported-event','seed-berth','event','Imported event','2019-07-01','2019-07-01','legacy','now','now');
        INSERT INTO import_jobs (id,name,status,created_at,updated_at)
            VALUES ('done','Finished import','completed','now','now'), ('cancelled','Cancelled import','cancelled','now','now');
        INSERT INTO import_files (id,job_id,name,sha256,row_count,status,created_at,updated_at)
            VALUES ('original','done','schedule.xlsx','hash-one',1,'completed','now','now'),
                   ('partial','cancelled','partial.xlsx','hash-two',1,'cancelled','now','now');
        INSERT INTO import_files (id,job_id,name,sha256,row_count,status,duplicate_of_file_id,created_at,updated_at)
            VALUES ('copy','cancelled','copy.xlsx','hash-one',1,'duplicate','original','now','now');
        INSERT INTO import_rows (job_id,file_id,row_index,content_hash,status,stage_token)
            VALUES ('done','original',0,'row-hash','imported','stage-one'), ('cancelled','partial',0,'pending-hash','staged','stage-two');
        INSERT INTO issues (id,type,reservation_id,other_reservation_id,berth_id,start_date,end_date,created_at)
            VALUES ('imported-issue','overlap','seed-event','imported-event','seed-berth','2019-07-01','2019-07-01','now');
        INSERT INTO import_issue_links (issue_id,job_id,file_id,commit_token)
            VALUES ('imported-issue','done','original','commit-one');
    """)
    for _ in range(2):
        connection.executescript(seed)
        for table in ["import_issue_links", "import_rows", "import_files", "import_jobs", "issues"]:
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
        assert connection.execute("SELECT id FROM reservations").fetchall() == [("seed-event",)]
        assert connection.execute("SELECT id FROM berths").fetchall() == [("seed-berth",)]
        assert connection.execute("SELECT reservation_id FROM reservation_import_keys").fetchall() == [("seed-event",)]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("existing,force,should_seed", [
    (None, False, True),
    ("INSERT INTO berths (id,name) VALUES ('new','New resource')", False, False),
    ("INSERT INTO import_jobs (id,name,created_at,updated_at) VALUES ('job','Prepared import','now','now')", False, False),
    ("INSERT INTO app_meta (key,value) VALUES ('import_summary','{}')", False, False),
    ("INSERT INTO berths (id,name) VALUES ('new','New resource')", True, True),
])
def test_normal_deploy_preserves_data_and_only_explicit_reseed_overrides(tmp_path, existing, force, should_seed):
    path = tmp_path / "database.sqlite"
    connection = database(path)
    if existing:
        connection.execute(existing)
    connection.commit()
    connection.close()
    # The real shell script and SQL run locally; the Wrangler stub records a seed
    # request instead of accessing Cloudflare or changing application data.
    wrapper = tmp_path / "npx"
    wrapper.write_text(f"#!{sys.executable}\n" + """
import json, os, sqlite3, sys
from pathlib import Path
args = sys.argv[1:]
if '--command' in args:
    query = args[args.index('--command') + 1]
    value = sqlite3.connect(os.environ['SEED_TEST_DB']).execute(query).fetchone()[0]
    print(json.dumps([{'results': [{'n': value}]}]))
elif '--file' in args:
    Path(os.environ['SEED_TEST_MARKER']).write_text(args[args.index('--file') + 1])
else:
    raise RuntimeError('Unexpected Wrangler command')
""")
    wrapper.chmod(0o755)
    marker = tmp_path / "seed-requested"
    environment = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
                   "SEED_TEST_DB": str(path), "SEED_TEST_MARKER": str(marker), "FORCE_RESEED": str(force).lower()}
    subprocess.run(["bash", str(ROOT / "scripts" / "ci" / "seed-if-empty.sh")], cwd=ROOT,
                   env=environment, check=True, capture_output=True, text=True)
    assert marker.exists() == should_seed
