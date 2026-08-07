#!/usr/bin/env python3
"""Publish supabase/schema.sql as a Supabase migration.

schema.sql is the source of truth and the thing `npm run verify:sql` executes on
real Postgres. Supabase deploys from supabase/migrations/. Keeping two hand-
edited copies of 630 lines of DDL is how a deployed database drifts from the one
that was verified, so the migration is generated from the schema and
`verify:sql` fails if they have come apart.

    python3 scripts/sync_migration.py          # write the migration
    python3 scripts/sync_migration.py --check   # exit 1 if out of date
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "supabase" / "schema.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "20260807000000_ctv_os_init.sql"

HEADER = """-- GENERATED FILE — do not edit.
--
-- Source: supabase/schema.sql   (sha256 {digest})
-- Regenerate: npm run db:migration
--
-- schema.sql is what `npm run verify:sql` executes against real Postgres. This
-- is the same bytes, so what gets deployed is what was verified.

"""


def build() -> str:
    body = SCHEMA.read_text()
    digest = hashlib.sha256(body.encode()).hexdigest()[:16]
    return HEADER.format(digest=digest) + body


def main() -> None:
    want = build()
    check = "--check" in sys.argv
    current = MIGRATION.read_text() if MIGRATION.exists() else None

    if check:
        if current != want:
            sys.exit(
                "migration is out of date with supabase/schema.sql — run: npm run db:migration"
            )
        print(f"migration matches schema.sql ({len(want.splitlines())} lines)")
        return

    MIGRATION.parent.mkdir(parents=True, exist_ok=True)
    MIGRATION.write_text(want)
    print(f"{MIGRATION.relative_to(ROOT)}  {len(want.splitlines())} lines")


if __name__ == "__main__":
    main()
