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
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "prototype" / "template.html"
SYNC = ROOT / "prototype" / "sync.js"
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


def supabase_config() -> str:
    """The project the built page talks to, as a JSON literal, or `null`.

    Exactly two values cross into the page: the REST URL and the publishable
    key. The publishable key is designed to sit in a browser — row level
    security is what protects the data, and supabase/schema.sql requires a real
    session for every write. The secret key is deliberately not read here; it
    belongs to scripts/seed_supabase.mjs and nowhere near a build artifact.

    With no .env.local, this returns `null` and the build produces the
    self-contained localStorage prototype that came before any of this. That is
    not a degraded mode — it is what `npm run e2e` drives, from a file:// URL.
    """
    env = {}
    path = ROOT / ".env.local"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()

    url = os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY") or env.get("SUPABASE_ANON_KEY")
    if not url or not key:
        return "null"
    if "secret" in key or key.startswith("sbp_"):
        sys.exit(
            "refusing to build: SUPABASE_ANON_KEY looks like a secret or an\n"
            "access token. Only the publishable key may be inlined into the page."
        )
    return json.dumps({"url": url.rstrip("/"), "key": key})


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
        # Job descriptions for the crew page: committee roles verbatim from the
        # handover (Section Va) and the operational crew roles. Reference data,
        # not edited in the prototype.
        "role_descriptions": data.get("role_descriptions", {}),
        "events": data["events"],
        "tasks": data["tasks"],
        # The Kit locker renders the inventory. It is read-only in the prototype,
        # so it travels as reference data alongside societies and prep templates.
        "kit": data.get("kit", []),
    }

    cfg = supabase_config()
    sync = SYNC.read_text().replace("__SUPABASE__", cfg)

    html = TEMPLATE.read_text()
    for token, value in (
        ("__DATA__", json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
        ("__FONT_INTER__", b64("Inter.woff2")),
        ("__SYNC_JS__", sync),
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
    print(
        "supabase: local only — no .env.local"
        if cfg == "null"
        else f"supabase: {json.loads(cfg)['url']}"
    )


if __name__ == "__main__":
    main()
