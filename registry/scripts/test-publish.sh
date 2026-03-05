#!/bin/bash
# Test the publish flow
# Usage: ./scripts/test-publish.sh

set -e

# Load shared config
source "$(dirname "$0")/config.sh"

if [ ! -f .test-token ]; then
  echo "Error: .test-token not found"
  echo "Run: npm run auth:url and save the decoded JWT to .test-token"
  exit 1
fi

JWT=$(cat .test-token)
BASE_URL="${1:-$PRODUCTION_URL}"

echo "Testing with: $BASE_URL"
echo ""

echo "1. Testing /me endpoint..."
curl -s -H "Authorization: Bearer $JWT" "$BASE_URL/api/v1/me" | jq .
echo ""

echo "2. Testing publish to personal namespace..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/dossiers" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "namespace": "yuvaldim/test",
    "content": "---\nname: test-dossier\ntitle: Test Dossier\nversion: 1.0.0\n---\n\n# Test Dossier\n\nThis is a test dossier published via the API.",
    "changelog": "Initial test publish"
  }')

echo "$RESPONSE" | jq .
echo ""

# Check if publish succeeded
if echo "$RESPONSE" | jq -e '.name' > /dev/null 2>&1; then
  echo "Publish successful!"
else
  echo "Publish failed."
  exit 1
fi
