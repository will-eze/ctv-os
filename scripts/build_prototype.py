#!/usr/bin/env python3
"""Assemble the CTV OS prototype into one self-contained file.

Inlines data/year.json and the subsetted Inter woff2 so the page has no
external requests at all — it works from a file:// URL, from a phone with no
signal, and inside an Artifact's CSP.

Studio Essential asks for Inter at four weights. Inter ships as a variable
font (wght 100–900), so one 48 KB face covers all of them; four static cuts
would have been ~180 KB for the same result.

    python3 scripts/build_prototype.py
"""
import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "prototype" / "template.html"
OUT = ROOT / "prototype" / "ctv-os.html"
FONTS = ROOT / "prototype" / "fonts"
# The deploy artifact. Kept separate from prototype/ so that publishing the site
# cannot accidentally publish the screenshots, the fonts or the template.
DIST = ROOT / "dist" / "index.html"


def b64(name: str) -> str:
    path = FONTS / name
    if not path.exists():
        sys.exit(f"missing font: {path}\nrun scripts/fetch_fonts.py first")
    return base64.b64encode(path.read_bytes()).decode()


def main() -> None:
    data = json.loads((ROOT / "data" / "year.json").read_text())

    # Only what the page renders. Keeping the payload tight matters because it
    # is inlined, and because a field the UI never reads is a field that will
    # quietly go stale.
    payload = {
        # The crew directory renders the committee role and what each person is
        # signed off to operate, so those travel now too.
        "members": [
            {
                k: m[k]
                for k in ("id", "known_as", "full_name", "committee_role", "trained")
                if k in m
            }
            for m in data["members"]
        ],
        "societies": data["societies"],
        "prep_templates": data["prep_templates"],
        "events": data["events"],
        "tasks": data["tasks"],
    }

    html = TEMPLATE.read_text()
    for token, value in (
        ("__DATA__", json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
        ("__FONT_INTER__", b64("Inter.woff2")),
    ):
        if token not in html:
            sys.exit(f"template no longer contains {token}")
        html = html.replace(token, value)

    OUT.write_text(html)
    DIST.parent.mkdir(parents=True, exist_ok=True)
    DIST.write_text(html)

    open_roles = sum(
        1 for e in data["events"] for r in e.get("roles", []) if not r.get("member")
    )
    print(
        f"{OUT.relative_to(ROOT)}  {OUT.stat().st_size / 1024:.0f} KB  "
        f"{len(data['events'])} events  {open_roles} open roles"
    )
    print(f"{DIST.relative_to(ROOT)}  (deploy artifact)")


if __name__ == "__main__":
    main()
