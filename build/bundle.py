#!/usr/bin/env python3
"""Inline the shared engine and the generated JSON into each page template.

The artifact sandbox blocks external requests, so the data ships inside the HTML
rather than being fetched. Keeping the templates and the payload separate means
editing the app doesn't mean re-writing a megabyte of coordinates. The desktop
and mobile pages share src/core.js, inlined into both.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "src" / "core.js"
PAGES = ((ROOT / "src" / "app.html", ROOT / "caracal.html"),
         (ROOT / "src" / "mobile.html", ROOT / "caracal-mobile.html"))
DATA = (("/*INJECT:SIGHTINGS*/", ROOT / "data" / "sightings.json"),
        ("/*INJECT:BASEMAP*/", ROOT / "data" / "basemap.json"))


def payloads():
    out = {}
    core = CORE.read_text()
    if "</script" in core.lower():
        print(f"FATAL: {CORE.name} contains </script, which would end the host element",
              file=sys.stderr)
        return None
    out["/*INJECT:CORE*/"] = core
    for marker, path in DATA:
        payload = json.loads(path.read_text())          # parse = validate
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        # </script> inside a JSON string would close the host <script> element
        out[marker] = text.replace("</", "<\\/")
    return out


def main():
    inject = payloads()
    if inject is None:
        return 1
    for tpl, dest in PAGES:
        html = tpl.read_text()
        # data goes in last, so nothing inside the JSON is ever scanned for a marker
        for marker, text in inject.items():
            if marker not in html:
                print(f"FATAL: marker {marker} not in {tpl.name}", file=sys.stderr)
                return 1
            html = html.replace(marker, text)
        dest.write_text(html)
        print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size/1024/1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
