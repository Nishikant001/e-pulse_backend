#!/usr/bin/env python3
"""Phase 24 — migration reliability harness (MariaDB/MySQL, disposable database ONLY).
Usage: DB_* env set to a THROWAWAY database that already holds a sequelize.sync() schema; python3 scripts/migration-audit.py
1) runs every pending migration one by one; a migration that fails is recorded and marked as applied so the run can continue
2) rolls every migration back one by one (newest first); a down() that fails is recorded and marked as reverted
Prints a JSON summary. Never run against a production database."""
import json, os, re, subprocess, sys
CLI = ["npx", "sequelize-cli", "--config", "config/config.js", "--migrations-path", "migrations"]
def sh(args): 
    p = subprocess.run(args, capture_output=True, text=True); return p.returncode, (p.stdout + p.stderr)
files = sorted(f for f in os.listdir("migrations") if f.endswith(".js"))
def sql(q):
    return subprocess.run(["mariadb", "-uroot", "-S", os.environ.get("MDB_SOCK", "/home/claude/p24/mdb/run/m.sock"), os.environ["DB_NAME"], "-e", q], capture_output=True, text=True)
sql("CREATE TABLE IF NOT EXISTS SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY)")
up_fail, down_fail, up_ok = [], [], 0
for f in files:
    rc, out = sh(CLI + ["db:migrate", "--to", f])
    if rc == 0: up_ok += 1; continue
    m = re.search(r"ERROR: (.*)", out); up_fail.append({"migration": f, "error": (m.group(1) if m else out[-200:]).strip()[:160]})
    sql(f"INSERT IGNORE INTO SequelizeMeta(name) VALUES ('{f}')")
down_ok = 0
for f in reversed(files):
    rc, out = sh(CLI + ["db:migrate:undo"])
    if rc == 0: down_ok += 1; continue
    m = re.search(r"ERROR: (.*)", out); down_fail.append({"migration": f, "error": (m.group(1) if m else out[-200:]).strip()[:160]})
    sql(f"DELETE FROM SequelizeMeta WHERE name='{f}'")
print(json.dumps({"migrations": len(files), "up_ok": up_ok, "up_failed": up_fail, "down_ok": down_ok, "down_failed": down_fail}, indent=1))
