"""Golden tests: every trap found in the legacy workbook, pinned to a concrete record."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "migration" / "out"


@pytest.fixture(scope="session")
def data():
    subprocess.run([sys.executable, str(ROOT / "migration" / "extract.py"), "--input", str(ROOT / "data" / "dock_schedule.xlsx"),
                    "--out", str(OUT), "--generated-at", "2026-09-22T00:00:00+00:00"], check=True, capture_output=True)
    load = lambda n: json.loads((OUT / f"{n}.json").read_text())
    report = json.loads((OUT / "import_report.json").read_text())
    return {"res": load("reservations"), "vessels": {v["id"]: v for v in load("vessels")},
            "berths": {b["id"]: b for b in load("berths")}, "issues": load("issues"),
            "codes": report["summary"]["import_issues_by_code"], "summary": report["summary"],
            "import_issues": report["import_issues"]}


def find(data, **kw):
    return [r for r in data["res"] if all(r.get(k) == v for k, v in kw.items())]


def test_berths(data):
    lengths = {k: (b["length_ft"], b["is_exclusive"]) for k, b in data["berths"].items()}
    assert lengths == {"north-pier-west": (410, 1), "north-pier-face": (75, 1), "north-pier-east": (240, 1),
                       "inner-channel": (55, 1), "south-float-west": (90, 1), "south-float-east": (90, 1),
                       "small-craft-slips": (None, 0), "north-finger-piers": (None, 0), "unassigned": (None, 0)}


def test_all_23_years_and_date_range(data):
    years = {r["start_date"][:4] for r in data["res"]}
    assert {str(y) for y in range(1997, 2020)} <= years
    assert data["summary"]["data_range"] == {"from": "1997-08-01", "to": "2019-12-31"}


def test_formula_day_numbers_1990s(data):
    assert data["codes"]["DAY_NUMBERS_ARE_FORMULAS"] == 8
    assert any(r["vessel_id"] == "mv-northern-harbor" and r["start_date"] == "1997-11-01"
               and r["end_date"] == "1998-01-18" for r in data["res"])  # stitched across the year boundary


def test_bars_built_from_merges_and_fill(data):
    gc = [(r["start_date"], r["end_date"]) for r in find(data, berth_id="north-pier-west", vessel_id="rv-golden-compass")
          if r["start_date"].startswith("2010-0")][:3]
    assert gc == [("2010-01-01", "2010-01-08"), ("2010-01-21", "2010-02-28"), ("2010-03-04", "2010-03-26")]


def test_header_year_typo_uses_sheet_year(data):
    assert data["codes"]["HEADER_YEAR_MISMATCH"] == 2
    assert find(data, berth_id="north-pier-west", vessel_id="rv-golden-compass", start_date="2010-11-09")


def test_impossible_and_missing_header_days(data):
    assert data["codes"]["HEADER_INVALID_DAY"] == 2  # June 2008 lists 31, Feb 2009 lists 29
    assert data["codes"]["HEADER_MISSING_DAY"] == 3
    assert not [r for r in data["res"] if r["start_date"] in ("2008-06-31", "2009-02-29")]


def test_carryover_december_copies_are_skipped(data):
    assert data["summary"]["carryover_blocks_skipped"] == 3
    assert data["codes"]["CARRYOVER_MISMATCH"] == 3
    anchor = [r["start_date"] for r in find(data, berth_id="north-pier-west", vessel_id="rv-long-anchor")
              if r["start_date"].startswith("2001-12")]
    assert anchor[:2] == ["2001-12-05", "2001-12-07"]  # sheet 2001 wins over the shifted copy in sheet 2002


def test_duplicate_berth_rows_surface_overlaps(data):
    assert data["codes"]["DUPLICATE_BERTH_ROW"] == 10
    res = {r["id"]: r for r in data["res"]}
    pairs = {(res[i["reservation_id"]]["berth_id"], i["start_date"]) for i in data["issues"] if i["type"] == "overlap"}
    assert ("south-float-east", "2017-07-11") in pairs  # OSV Amber Reef vs "Utility work on pier face"
    assert ("north-pier-west", "1998-09-16") in pairs


def test_known_fit_violations(data):
    res = {r["id"]: r for r in data["res"]}
    combos = {(res[i["reservation_id"]]["vessel_id"], res[i["reservation_id"]]["berth_id"])
              for i in data["issues"] if i["type"] == "fit" and i["details"]["length_status"] == "known"}
    assert combos == {("mv-iron-heron", "inner-channel"), ("rv-clear-tern", "north-pier-face"),
                      ("sy-high-gannet", "south-float-east"), ("my-wild-tern", "south-float-east"),
                      ("sy-clear-beacon", "south-float-east")}


def test_disputed_lengths_use_larger_value(data):
    v = data["vessels"]
    assert (v["mv-deep-reef"]["length_ft"], v["mv-deep-reef"]["length_status"]) == (100, "disputed")
    assert (v["rv-high-reef"]["length_ft"], v["rv-high-reef"]["length_status"]) == (72, "disputed")
    assert (v["my-western-strand"]["length_ft"], v["my-western-strand"]["length_status"]) == (65, "disputed")
    assert v["rv-golden-compass"]["length_status"] == "unknown"


def test_shift_days_are_not_vessel_conflicts(data):
    assert all(i["details"]["shared_days"] >= 2 for i in data["issues"] if i["type"] == "vessel_double")


def test_record_integrity(data):
    for r in data["res"]:
        assert r["start_date"] <= r["end_date"]
        assert (r["kind"] == "vessel") == (r["vessel_id"] is not None)
        assert r["kind"] == "vessel" or r["title"]
        assert r["berth_id"] in data["berths"]
        assert r["vessel_id"] is None or r["vessel_id"] in data["vessels"]
    assert len({r["id"] for r in data["res"]}) == len(data["res"])


def test_counts_are_stable(data):
    s = data["summary"]
    assert s["reservations"] == 2587
    assert s["reservations_by_kind"] == {"vessel": 2047, "event": 89, "hold": 402, "closure": 49}
    assert s["schedule_issues_by_type"] == {"fit": 29, "vessel_double": 15, "overlap": 4}
    assert s["max_span_days"] == 425
