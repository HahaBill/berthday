#!/usr/bin/env bash
set -euo pipefail
URL=${1:?Pass the deployed berthday URL}
EXPECTED_VERSION=${2:-}
if [[ ! "$URL" =~ ^https://berthday\.[a-zA-Z0-9-]+\.workers\.dev$ ]]; then
  echo "Expected https://berthday.<subdomain>.workers.dev; got $URL" >&2
  exit 1
fi
CURL=(curl --fail --silent --show-error --retry 5 --retry-delay 2 --retry-connrefused)
"${CURL[@]}" "$URL/api/health" | EXPECTED_VERSION="$EXPECTED_VERSION" node --input-type=commonjs -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.ok!==true||typeof j.version!=="string"||(process.env.EXPECTED_VERSION&&j.version!==process.env.EXPECTED_VERSION))throw new Error("Unexpected health response");console.log(`Healthy berthday version ${j.version}`)})'
"${CURL[@]}" "$URL/api/meta" | node --input-type=commonjs -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  const seeded=["north-pier-west","north-pier-face","north-pier-east","inner-channel","south-float-west","south-float-east","small-craft-slips","north-finger-piers","unassigned"];
  const berths=Array.isArray(j.berths)?j.berths:[];
  const ids=new Set(berths.map(berth=>berth?.id));
  if(!j.dataRange?.from||!j.dataRange?.to||seeded.some(id=>!ids.has(id))||ids.size!==berths.length||berths.some(berth=>typeof berth?.id!=="string"||typeof berth.name!=="string"||typeof berth.isExclusive!=="boolean"))throw new Error("Missing seeded resource catalogue or invalid metadata");
})'
"${CURL[@]}" "$URL/api/import/jobs?limit=1" | node --input-type=commonjs -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  const statuses=["staging","ready","importing","completed","cancelled"];
  if(!Array.isArray(j.items)||(j.nextCursor!==null&&typeof j.nextCursor!=="string")||j.items.some(job=>typeof job?.id!=="string"||typeof job.name!=="string"||!statuses.includes(job.status)))throw new Error("Unexpected import jobs response");
})'
for route in / /issues /resources /import; do
  PAGE=$("${CURL[@]}" "$URL$route")
  if [[ "$PAGE" != *'<div id="root"'* ]]; then
    echo "Missing SPA root at $URL$route" >&2
    exit 1
  fi
done
RESPONSE=$(curl --silent --show-error --write-out $'\n%{http_code}' "$URL/api/does-not-exist")
STATUS=${RESPONSE##*$'\n'}
BODY=${RESPONSE%$'\n'*}
[[ "$STATUS" = 404 ]]
printf '%s' "$BODY" | node --input-type=commonjs -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).error?.code!=="NOT_FOUND")throw new Error("Expected JSON API 404")})'
echo "Berthday smoke test passed: $URL"
