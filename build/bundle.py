#!/usr/bin/env python3
"""Inline the generated JSON into the page template.

The artifact sandbox blocks external requests, so the data ships inside the HTML
rather than being fetched. Keeping the template and the payload separate means
editing the app doesn't mean re-writing a megabyte of coordinates.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TPL = ROOT / "src" / "app.html"
OUT = ROOT / "caracal.html"


def main():
    html = TPL.read_text()
    for marker, path in (("/*INJECT:SIGHTINGS*/", ROOT / "data" / "sightings.json"),
                         ("/*INJECT:BASEMAP*/", ROOT / "data" / "basemap.json")):
        if marker not in html:
            print(f"FATAL: marker {marker} not in template", file=sys.stderr)
            return 1
        payload = json.loads(path.read_text())          # parse = validate
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        # </script> inside a JSON string would close the host <script> element
        text = text.replace("</", "<\\/")
        html = html.replace(marker, text)

    OUT.write_text(html)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size/1024/1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
