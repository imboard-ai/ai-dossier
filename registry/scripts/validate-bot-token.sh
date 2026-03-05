#!/bin/bash
# Validate GITHUB_BOT_TOKEN has correct permissions
# Usage: ./scripts/validate-bot-token.sh

# Load environment variables
if [ -f .env.local ]; then
  export $(grep GITHUB_BOT_TOKEN .env.local | xargs)
fi

if [ -z "$GITHUB_BOT_TOKEN" ]; then
  echo "Error: GITHUB_BOT_TOKEN not found in .env.local"
  echo "Run: vercel env pull .env.local"
  exit 1
fi

echo "Checking token permissions..."
echo ""

# Check if we can read the content repo
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/imboard-ai/dossier-content/contents/index.json")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ Read access to dossier-content: OK"
else
  echo "✗ Read access failed (HTTP $HTTP_CODE)"
  echo "$BODY" | head -5
  exit 1
fi

# Check repository permissions
PERMS=$(curl -s \
  -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/imboard-ai/dossier-content" | grep -o '"push":[^,]*')

if echo "$PERMS" | grep -q "true"; then
  echo "✓ Write access to dossier-content: OK"
else
  echo "✗ Write access: NOT GRANTED"
  echo "  Make sure the token has 'Contents: Read and Write' permission"
  exit 1
fi

echo ""
echo "Token validation successful!"
