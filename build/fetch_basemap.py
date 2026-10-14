#!/usr/bin/env python3
"""Fetch and inline a basemap, because the artifact sandbox blocks tile servers.

Produces data/basemap.json with two layers:
  peninsula -- high-detail OSM coastline stitched into land polygons, plus
               terrestrial protected areas, plus the official SANParks 2017
               Table Mountain National Park boundary (data/tmnp/)
  national  -- Natural Earth 10m country outlines for the zoomed-out view

Both are simplified with Douglas-Peucker and rounded, so the whole thing can sit
inside the HTML page with no network access at runtime.
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / ".cache"
OUT = ROOT / "data" / "basemap.json"
TMNP = ROOT / "data" / "tmnp" / "2017_TMNP_boundary.shp"
PARK_NAME = "Table Mountain National Park"

UA = "caracal-sightings-viz/1.0 (research visualisation)"
OVERPASS = "https://overpass-api.de/api/interpreter"
NE_BASE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
           "master/geojson/")

# Peninsula view: greater Cape Town, padded past the sighting bbox so the
# coastline doesn't stop dead at the edge of the data.
PEN_BBOX = (-34.42, 18.24, -33.66, 18.92)   # s, w, n, e
# National view.
SA_BBOX = (-35.5, 15.5, -21.5, 34.0)


def fetch(url, data=None, cache_key=None, pause=3.0):
    if cache_key:
        cached = CACHE / cache_key
        if cached.exists():
            print(f"  cached  {cache_key}")
            return cached.read_text()
    print(f"  GET     {cache_key or url[:70]}")
    if data is not None:
        url = url + "?" + urllib.parse.urlencode({"data": data})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                text = r.read().decode("utf-8")
            break
        except Exception as e:                                  # noqa: BLE001
            if attempt == 3:
                raise
            wait = 10 * (attempt + 1)
            print(f"    retry in {wait}s ({e})")
            time.sleep(wait)
    if cache_key:
        CACHE.mkdir(parents=True, exist_ok=True)
        (CACHE / cache_key).write_text(text)
    time.sleep(pause)
    return text


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def rdp(points, eps):
    """Ramer-Douglas-Peucker, iterative so long coastlines can't blow the stack."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = points[lo]
        bx, by = points[hi]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = points[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, best_i = d, i
        if best > eps:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [p for p, k in zip(points, keep) if k]


def signed_area(ring):
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def round_ring(ring, dp=5):
    out, last = [], None
    for x, y in ring:
        p = (round(x, dp), round(y, dp))
        if p != last:
            out.append([p[0], p[1]])
            last = p
    return out


# --------------------------------------------------------------------------
# peninsula coastline -> land polygons
# --------------------------------------------------------------------------
def stitch_coastline(ways, bbox):
    """Join OSM coastline ways into chains, then close them against the bbox.

    OSM's convention is land-on-the-left along each way, so a chain that leaves
    the bbox can be closed by walking the bbox boundary; picking the walk
    direction that yields a counterclockwise ring gives the land side.
    """
    s, w, n, e = bbox
    chains = [list(way) for way in ways if len(way) > 1]

    # repeatedly weld chains that share an endpoint
    merged = True
    while merged:
        merged = False
        ends = {}
        for idx, c in enumerate(chains):
            if c[0] == c[-1]:
                continue
            ends.setdefault(c[-1], []).append(idx)
        for idx, c in enumerate(chains):
            if c[0] == c[-1]:
                continue
            for jdx in ends.get(c[0], []):
                if jdx != idx and chains[jdx] and chains[idx]:
                    chains[jdx] = chains[jdx] + chains[idx][1:]
                    chains[idx] = []
                    merged = True
                    break
            if merged:
                chains = [c for c in chains if c]
                break

    polys, lines = [], []
    for c in chains:
        if len(c) < 3:
            continue
        if c[0] == c[-1]:
            polys.append(c[:-1])                    # an island, already closed
            continue
        lines.append(c)

    # corners in counterclockwise order for a lon/lat (x=lon, y=lat) frame
    corners = [(w, s), (e, s), (e, n), (w, n)]

    def edge_pos(pt):
        """Position along the ccw bbox perimeter, 0..4."""
        x, y = pt
        x = min(max(x, w), e)
        y = min(max(y, s), n)
        ew, eh = (e - w) or 1e-9, (n - s) or 1e-9
        db, dr = abs(y - s), abs(x - e)
        dt, dl = abs(y - n), abs(x - w)
        m = min(db, dr, dt, dl)
        if m == db:
            return 0 + (x - w) / ew
        if m == dr:
            return 1 + (y - s) / eh
        if m == dt:
            return 2 + (e - x) / ew
        return 3 + (n - y) / eh

    for c in lines:
        start_p, end_p = edge_pos(c[0]), edge_pos(c[-1])
        walk = []
        pos = end_p
        guard = 0
        while guard < 12:
            guard += 1
            nxt = math.floor(pos) + 1
            target = start_p if (start_p > pos or guard > 8) else None
            if target is not None and pos < start_p <= nxt:
                break
            corner = corners[int(nxt) % 4]
            walk.append(corner)
            pos = nxt % 4 if nxt >= 4 else nxt
            if pos < end_p and start_p >= pos:
                if pos <= start_p <= math.floor(pos) + 1:
                    break
        ring = c + walk
        if signed_area(ring) < 0:
            ring = list(reversed(ring))
        if len(ring) >= 3:
            polys.append(ring)
    return polys, lines


def overpass_ways(query, cache_key):
    raw = json.loads(fetch(OVERPASS, data=query, cache_key=cache_key))
    nodes, ways = {}, []
    for el in raw["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
    for el in raw["elements"]:
        if el["type"] == "way":
            pts = [nodes[n] for n in el.get("nodes", []) if n in nodes]
            if len(pts) > 1:
                ways.append(pts)
    return ways, raw


def build_peninsula():
    s, w, n, e = PEN_BBOX
    bbox = f"({s},{w},{n},{e})"
    print("peninsula coastline")
    ways, _ = overpass_ways(
        f'[out:json][timeout:180];way["natural"="coastline"]{bbox};'
        f'(._;>;);out skel qt;', "coastline.json")
    print(f"  {len(ways)} coastline ways")
    polys, lines = stitch_coastline(ways, PEN_BBOX)
    print(f"  stitched into {len(polys)} land polygons")

    print("protected areas")
    raw = json.loads(fetch(
        OVERPASS,
        data=(f'[out:json][timeout:180];'
              f'(relation["leisure"="nature_reserve"]{bbox};'
              f' way["leisure"="nature_reserve"]{bbox};'
              f' relation["boundary"="protected_area"]["protect_class"!~"^(1[0-9]|2[0-9])$"]{bbox};);'
              f'out geom;'),
        cache_key="reserves.json"))
    reserves = []
    for el in raw["elements"]:
        name = el.get("tags", {}).get("name", "")
        low = name.lower()
        # marine zones would smear blue blobs across the sea; caracals are on land
        if "marine" in low or "restricted zone" in low or "control" in low:
            continue
        # OSM's copy of the park is superseded by the official boundary
        if name == PARK_NAME:
            continue
        rings = []
        if el["type"] == "way" and el.get("geometry"):
            rings = [[(p["lon"], p["lat"]) for p in el["geometry"]]]
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") in ("outer", "") and m.get("geometry"):
                    rings.append([(p["lon"], p["lat"]) for p in m["geometry"]])
        for r in rings:
            if len(r) >= 4:
                reserves.append({"name": name, "ring": r})
    print(f"  {len(reserves)} terrestrial reserve rings")
    return polys, lines, reserves


def build_tmnp():
    """Official TMNP outline: terrestrial polygons only, holes kept as rings.

    Rings are drawn with an even-odd fill, so interior rings punch out the
    enclaves (private land, Kirstenbosch, etc.) that sit inside the park.
    """
    import geopandas as gpd
    print("TMNP boundary")
    gdf = gpd.read_file(TMNP).to_crs("EPSG:4326")
    gdf = gdf[gdf["Category"] == "Terrestrial"]
    rings = []
    for geom in gdf.geometry:
        for poly in getattr(geom, "geoms", [geom]):
            rings.append(list(poly.exterior.coords))
            rings.extend(list(r.coords) for r in poly.interiors)
    print(f"  {len(gdf)} polygons, {len(rings)} rings")
    return rings


def build_national():
    print("national outline")
    raw = json.loads(fetch(NE_BASE + "ne_10m_admin_0_countries.geojson",
                           cache_key="ne_countries.geojson", pause=0))
    wanted = {"South Africa", "Lesotho", "Eswatini", "eSwatini", "Swaziland",
              "Namibia", "Botswana", "Zimbabwe", "Mozambique"}
    out = []
    for f in raw["features"]:
        p = f["properties"]
        name = p.get("NAME") or p.get("ADMIN") or ""
        if name not in wanted:
            continue
        geom = f["geometry"]
        polys = ([geom["coordinates"]] if geom["type"] == "Polygon"
                 else geom["coordinates"])
        rings = []
        for poly in polys:
            ring = [(x, y) for x, y in poly[0]]
            ys = [y for _, y in ring]
            xs = [x for x, _ in ring]
            if (max(ys) < SA_BBOX[0] or min(ys) > SA_BBOX[2]
                    or max(xs) < SA_BBOX[1] or min(xs) > SA_BBOX[3]):
                continue
            rings.append(ring)
        if rings:
            out.append({"name": name, "rings": rings,
                        "focus": name == "South Africa"})
    print(f"  {len(out)} countries")
    return out


def main():
    polys, lines, reserves = build_peninsula()
    park_rings = build_tmnp()
    countries = build_national()

    # tolerances in degrees: ~15 m for the peninsula, ~1.1 km nationally
    PEN_EPS, NAT_EPS = 0.00015, 0.01

    basemap = {
        "peninsula": {
            "bbox": [PEN_BBOX[1], PEN_BBOX[0], PEN_BBOX[3], PEN_BBOX[2]],
            "land": [round_ring(rdp(p, PEN_EPS)) for p in polys
                     if len(rdp(p, PEN_EPS)) >= 3],
            "coast": [round_ring(rdp(l, PEN_EPS)) for l in lines
                      if len(rdp(l, PEN_EPS)) >= 2],
            "reserves": [
                {"name": r["name"], "ring": round_ring(rdp(r["ring"], PEN_EPS * 2))}
                for r in reserves if len(rdp(r["ring"], PEN_EPS * 2)) >= 3
            ],
            "park": {
                "name": PARK_NAME,
                "rings": [round_ring(rdp(r, PEN_EPS)) for r in park_rings
                          if len(rdp(r, PEN_EPS)) >= 3],
            },
        },
        "national": {
            "bbox": [SA_BBOX[1], SA_BBOX[0], SA_BBOX[3], SA_BBOX[2]],
            "countries": [
                {"name": c["name"], "focus": c["focus"],
                 "rings": [round_ring(rdp(r, NAT_EPS), 4) for r in c["rings"]
                           if len(rdp(r, NAT_EPS)) >= 3]}
                for c in countries
            ],
        },
        "attribution": "Coastline & protected areas © OpenStreetMap "
                       "contributors (ODbL). Table Mountain National Park "
                       "boundary © SANParks (2017). Country outlines: "
                       "Natural Earth.",
    }

    OUT.write_text(json.dumps(basemap, separators=(",", ":")))
    pen = basemap["peninsula"]
    print()
    print(f"land polygons      {len(pen['land'])} "
          f"({sum(len(p) for p in pen['land'])} pts)")
    print(f"coast lines        {len(pen['coast'])} "
          f"({sum(len(p) for p in pen['coast'])} pts)")
    print(f"reserves           {len(pen['reserves'])}")
    print(f"park rings         {len(pen['park']['rings'])} "
          f"({sum(len(r) for r in pen['park']['rings'])} pts)")
    print(f"countries          {len(basemap['national']['countries'])}")
    print(f"wrote              {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
