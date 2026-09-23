#!/usr/bin/env bash
set -euo pipefail
DB=berthday
COUNT=$(npx wrangler d1 execute "$DB" --remote --json --command "SELECT COUNT(*) AS n FROM reservations" \
  | node --input-type=commonjs -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("["),s.lastIndexOf("]")+1));const n=(Array.isArray(j)?j[0]:j).results[0].n;if(!Number.isInteger(n)||n<0)throw new Error("Invalid reservation count");console.log(n)})')
echo "Reservations in remote berthday D1: $COUNT"
if [ "$COUNT" = "0" ] || [ "${FORCE_RESEED:-false}" = "true" ]; then
  npx wrangler d1 execute "$DB" --remote --file migration/out/seed.sql
  echo "Seeded berthday"
else
  echo "Already seeded; skipping (run the workflow with reseed=true to reset)"
fi
