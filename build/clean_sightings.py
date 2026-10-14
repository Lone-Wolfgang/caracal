#!/usr/bin/env python3
"""Clean sightings.xlsx into the JSON the artifact inlines.

Three things the raw file needs fixing for, all documented in the plan:
  * Latitude/Longitude column headers are swapped (all rows but two)
  * Activity has 26 values that are really ~10 (case, typos, synonyms)
  * Contact name/email must never leave this script

Each record is also tagged with whether it falls inside the official Table
Mountain National Park boundary (SANParks 2017 shapefile in data/tmnp/).
"""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "sightings.xlsx"
OUT = ROOT / "data" / "sightings.json"
QA_OUT = ROOT / "data" / "quality_report.json"
TMNP = ROOT / "data" / "tmnp" / "2017_TMNP_boundary.shp"

# South Africa's envelope, generous enough for every legitimate sighting.
SA_LAT = (-35.0, -22.0)
SA_LON = (16.0, 34.0)

# The peninsula / greater Cape Town view, where 93% of the data lives.
PEN_LAT = (-34.5, -33.7)
PEN_LON = (18.2, 18.8)


def resolve_coords(a, b):
    """Return (lat, lon) for a row, or (None, None).

    `a` is the "Latitude" cell and `b` the "Longitude" cell, but the headers are
    swapped for all rows but two, and one row additionally has both signs
    flipped. Rather than special-casing row numbers, try the four plausible
    readings in order of likelihood and take the first that lands in South
    Africa. Verified during planning to resolve all 1637 rows that have
    coordinates, with zero ambiguity.
    """
    if a is None or b is None or pd.isna(a) or pd.isna(b):
        return None, None
    candidates = [
        (b, a),                      # the normal case: headers are swapped
        (a, b),                      # rows 1600/1638: entered as labelled
        (-abs(b), abs(a)),           # swapped, signs dropped
        (-abs(a), abs(b)),           # as-labelled, signs dropped
    ]
    for lat, lon in candidates:
        if SA_LAT[0] <= lat <= SA_LAT[1] and SA_LON[0] <= lon <= SA_LON[1]:
            return round(float(lat), 6), round(float(lon), 6)
    return None, None


# Row-level corrections for typos in the source spreadsheet, keyed by row index.
# Row 5 (Sept 2026 export): Location was overwritten with "1", but the comment
# still places it "above the Clovelly Golf Course", which the earlier export had.
LOCATION_FIXES = {5: "Clovelly Golf Course"}


def load_park():
    """Terrestrial TMNP polygons as one prepared geometry for point-in-polygon.

    The shapefile also carries a marine protected area (Boulders), which is
    dropped: a sighting on land next to the penguins is not "in the sea park".
    """
    gdf = gpd.read_file(TMNP).to_crs("EPSG:4326")
    gdf = gdf[gdf["Category"] == "Terrestrial"]
    return prep(unary_union(list(gdf.geometry)))


ACTIVITY_MAP = {
    "walking": "Walking",
    "driving": "Driving",
    "running": "Running",
    "cycling": "Cycling",
    "cyling": "Cycling",
    "cylcling": "Cycling",
    "at home": "At home",
    "at work": "At work",
    "hiking": "Hiking",
    "fishing": "Fishing",
    "parked": "Parked",
    "at restaurant": "At a restaurant",
    "riding cable car": "Cable car",
    "horseback riding": "Horseback riding",
    "riding": "Horseback riding",
    "bird watching": "Birdwatching",
    "birdwatching": "Birdwatching",
    "camera trap": "Camera trap",
    "on camera": "Camera trap",
    "camera footage": "Camera trap",
}


def normalize_activity(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    key = re.sub(r"\s+", " ", str(v)).strip().lower()
    if not key:
        return None
    return ACTIVITY_MAP.get(key, str(v).strip())


# Tag Colour is free text ("Blue on the left ear, green on the right"), so pull
# out whatever colours are named rather than treating the field as an enum.
COLOR_WORDS = [
    ("turquoise", "turquoise"), ("cyan", "turquoise"), ("teal", "turquoise"),
    ("blue", "blue"), ("green", "green"), ("red", "red"), ("yellow", "yellow"),
    ("orange", "orange"), ("purple", "purple"), ("violet", "purple"),
    ("white", "white"), ("silver", "silver"), ("pink", "pink"),
]


def parse_tag_colors(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return []
    text = str(v).lower()
    found = []
    for word, canon in COLOR_WORDS:
        if word in text and canon not in found:
            found.append(canon)
    return found


EMAIL_RE = re.compile(r"[\w.+-]+\s*@\s*[\w-]+(?:\.[\w-]+)+")


def build_name_redactor(series):
    """Match reporter names that turn up inside other people's free text.

    Two commenters name the person who originally reported a sighting, and one
    comment carries an org email. Stripping the contact columns is not enough if
    the same details survive in the narrative, so redact them there too. Only
    full names (two or more tokens) are matched, so ordinary words in the roster
    can't blank out unrelated text.
    """
    patterns = []
    for raw in series.dropna().astype(str):
        name = re.sub(r"\s+", " ", raw).strip()
        if len(name.split()) >= 2 and len(name) >= 6:
            patterns.append(re.escape(name))
    if not patterns:
        return None
    patterns.sort(key=len, reverse=True)
    return re.compile("|".join(patterns), re.IGNORECASE)


NAME_RE = None  # set in main() from the contact roster


def clean_text(v, redact=False):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = re.sub(r"[ \t]+", " ", str(v)).strip()
    s = re.sub(r"\n{3,}", "\n\n", s)
    if redact:
        s = EMAIL_RE.sub("[email withheld]", s)
        if NAME_RE is not None:
            s = NAME_RE.sub("[name withheld]", s)
    return s or None


def as_int(v):
    if v is None or pd.isna(v):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def main():
    global NAME_RE
    df = pd.read_excel(SRC)
    NAME_RE = build_name_redactor(df["Contact Name"])
    park = load_park()
    raw_activities = df["Activity"].dropna().nunique()

    records = []
    unresolved = []
    for i, row in df.iterrows():
        lat, lon = resolve_coords(row["Latitude"], row["Longitude"])
        if lat is None and pd.notna(row["Latitude"]):
            unresolved.append({"row": int(i), "location": str(row["Location"])})

        date = row["Date"]
        date_iso = None if pd.isna(date) else pd.Timestamp(date).strftime("%Y-%m-%d")

        t = row["Time"]
        hour = t.hour if hasattr(t, "hour") else None
        time_str = t.strftime("%H:%M") if hasattr(t, "hour") else None

        email = row["Contact Email"]
        if pd.isna(email) or not str(email).strip():
            reporter = None
        else:
            digest = hashlib.sha256(str(email).strip().lower().encode()).hexdigest()
            reporter = digest[:8]

        tag_colour_raw = clean_text(row["Tag Colour"])

        rec = {
            "id": int(i),
            "location": LOCATION_FIXES.get(int(i)) or clean_text(row["Location"]),
            "date": date_iso,
            "year": None if date_iso is None else int(date_iso[:4]),
            "month": None if date_iso is None else int(date_iso[5:7]),
            # 0 = Monday .. 6 = Sunday
            "dow": None if date_iso is None else pd.Timestamp(date_iso).weekday(),
            "time": time_str,
            "hour": hour,
            "lat": lat,
            "lon": lon,
            "peninsula": bool(
                lat is not None
                and PEN_LAT[0] <= lat <= PEN_LAT[1]
                and PEN_LON[0] <= lon <= PEN_LON[1]
            ),
            "in_park": bool(lat is not None and park.covers(Point(lon, lat))),
            "activity": normalize_activity(row["Activity"]),
            "alone": bool(row["Alone"]),
            "people": as_int(row["Number of People"]),
            "dog": bool(row["Dog"]),
            "caracals": as_int(row["Number of Caracals"]),
            "collar": bool(row["Radio Collar"]),
            "tags": bool(row["Ear Tags"]),
            "tag_colour": tag_colour_raw,
            "tag_colors": parse_tag_colors(tag_colour_raw),
            "caracal_id": clean_text(row["Caracal ID"]),
            "response": clean_text(row["Caracal Response"], redact=True),
            "comments": clean_text(row["Comments"], redact=True),
            "reporter": reporter,
        }
        records.append(rec)

    # --- QA: coordinate collisions -------------------------------------------
    # Two unrelated sightings sharing a coordinate to 6 decimal places is
    # essentially impossible by chance, so these are copy-paste artifacts. We
    # cannot tell which row of a pair is wrong without geocoding, so flag only.
    collisions = []
    for axis, other in (("lat", "lon"), ("lon", "lat")):
        buckets = {}
        for r in records:
            if r[axis] is None:
                continue
            buckets.setdefault(r[axis], []).append(r)
        for value, rows in buckets.items():
            if len({r[other] for r in rows}) > 1:
                collisions.append({
                    "axis": axis,
                    "value": value,
                    "rows": [
                        {"id": r["id"], "location": r["location"], "date": r["date"],
                         "lat": r["lat"], "lon": r["lon"]}
                        for r in sorted(rows, key=lambda r: r["id"])
                    ],
                })
    collisions.sort(key=lambda c: c["rows"][0]["id"])

    qa = {
        "total_records": len(records),
        "with_coords": sum(1 for r in records if r["lat"] is not None),
        "in_park": sum(1 for r in records if r["in_park"]),
        "missing_coords": [
            {"id": r["id"], "location": r["location"], "date": r["date"]}
            for r in records if r["lat"] is None
        ],
        "unresolved_coords": unresolved,
        "missing_date": [
            {"id": r["id"], "location": r["location"]}
            for r in records if r["date"] is None
        ],
        "coordinate_collisions": collisions,
        "activity_values_before": int(raw_activities),
        "activity_values_after": len({r["activity"] for r in records if r["activity"]}),
    }

    # --- Guard: no PII may reach the output ----------------------------------
    blob = json.dumps(records, ensure_ascii=False)
    if EMAIL_RE.search(blob):
        print(f"FATAL: email-shaped text survived redaction: "
              f"{EMAIL_RE.findall(blob)[:5]}", file=sys.stderr)
        return 1
    names = set(df["Contact Name"].dropna().astype(str))
    emails = set(df["Contact Email"].dropna().astype(str))
    leaked = [v for v in (names | emails) if v and v in blob]
    if leaked:
        print(f"FATAL: contact PII leaked into output: {leaked[:5]}", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")))
    QA_OUT.write_text(json.dumps(qa, ensure_ascii=False, indent=2))

    print(f"records            {len(records)}")
    print(f"with coordinates   {qa['with_coords']}")
    print(f"unresolved coords  {len(unresolved)}")
    print(f"missing coords     {len(qa['missing_coords'])}")
    print(f"missing date       {len(qa['missing_date'])}")
    print(f"peninsula          {sum(1 for r in records if r['peninsula'])}")
    print(f"elsewhere in SA    {sum(1 for r in records if r['lat'] and not r['peninsula'])}")
    print(f"in TMNP            {qa['in_park']}")
    print(f"outside TMNP       {qa['with_coords'] - qa['in_park']}")
    print(f"activity values    {qa['activity_values_before']} -> {qa['activity_values_after']}")
    print(f"coord collisions   {len(collisions)} groups")
    print(f"wrote              {OUT.relative_to(ROOT)} ({OUT.stat().st_size/1024:.0f} KB)")
    print(f"wrote              {QA_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
