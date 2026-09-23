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
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.dataRange?.from||!j.dataRange?.to||!Array.isArray(j.berths)||j.berths.length!==9)throw new Error("Missing seeded metadata")})'
for route in / /issues; do
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
