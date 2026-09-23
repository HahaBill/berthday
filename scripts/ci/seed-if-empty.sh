#!/usr/bin/env bash
set -euo pipefail
DB=berthday
HAS_DATA=$(npx wrangler d1 execute "$DB" --remote --json --command "SELECT (EXISTS(SELECT 1 FROM reservations) OR EXISTS(SELECT 1 FROM vessels) OR EXISTS(SELECT 1 FROM berths) OR EXISTS(SELECT 1 FROM app_meta) OR EXISTS(SELECT 1 FROM import_issues) OR EXISTS(SELECT 1 FROM import_jobs) OR EXISTS(SELECT 1 FROM reservation_import_keys)) AS n" \
  | node --input-type=commonjs -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("["),s.lastIndexOf("]")+1));const n=(Array.isArray(j)?j[0]:j).results[0].n;if(n!==0&&n!==1)throw new Error("Invalid existing-data result");console.log(n)})')
echo "Existing application data in remote berthday D1: $HAS_DATA"
if [ "$HAS_DATA" = "0" ] || [ "${FORCE_RESEED:-false}" = "true" ]; then
  npx wrangler d1 execute "$DB" --remote --file migration/out/seed.sql
  echo "Seeded berthday"
else
  echo "Existing data found; skipping (run the workflow with reseed=true to reset)"
fi
