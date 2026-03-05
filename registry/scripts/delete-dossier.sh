#!/bin/bash
#
# Delete a dossier from the content repo
#
# This script removes a dossier file and its entry from the manifest.
# It uses the GITHUB_BOT_TOKEN from .env.local to authenticate.
#
# Prerequisites:
#   - GITHUB_BOT_TOKEN in .env.local (run: vercel env pull .env.local)
#   - jq installed
#
# Usage:
#   ./scripts/delete-dossier.sh <dossier-name>
#
# Arguments:
#   dossier-name  Full dossier path (e.g., "yuvaldim/test/my-dossier")
#
# Examples:
#   ./scripts/delete-dossier.sh yuvaldim/test/test-dossier
#   ./scripts/delete-dossier.sh imboard-ai/development/old-dossier
#
# What it does:
#   1. Deletes the .ds.md file from the dossier-content repo
#   2. Updates index.json to remove the dossier entry
#
# Note: This is an admin operation. There is no API endpoint for deletion.
#

set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/delete-dossier.sh <dossier-name>"
  echo "Example: ./scripts/delete-dossier.sh yuvaldim/test/test-dossier"
  exit 1
fi

DOSSIER_NAME="$1"
FILE_PATH="${DOSSIER_NAME}.ds.md"

# Load bot token
if [ -f .env.local ]; then
  export $(grep GITHUB_BOT_TOKEN .env.local | xargs)
fi

if [ -z "$GITHUB_BOT_TOKEN" ]; then
  echo "Error: GITHUB_BOT_TOKEN not found"
  exit 1
fi

REPO="imboard-ai/dossier-content"
API="https://api.github.com"

echo "Deleting dossier: $DOSSIER_NAME"
echo ""

# 1. Get file SHA
echo "1. Getting file SHA..."
FILE_INFO=$(curl -s -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
  "$API/repos/$REPO/contents/$FILE_PATH")

FILE_SHA=$(echo "$FILE_INFO" | jq -r '.sha // empty')

if [ -z "$FILE_SHA" ]; then
  echo "   File not found: $FILE_PATH"
else
  echo "   Found: $FILE_SHA"

  # Delete file
  echo "2. Deleting file..."
  curl -s -X DELETE \
    -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$API/repos/$REPO/contents/$FILE_PATH" \
    -d "{\"message\":\"Delete $DOSSIER_NAME\",\"sha\":\"$FILE_SHA\"}" | jq '{commit: .commit.sha}'
fi

# 2. Update manifest
echo "3. Updating manifest..."
MANIFEST_INFO=$(curl -s -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
  "$API/repos/$REPO/contents/index.json")

MANIFEST_SHA=$(echo "$MANIFEST_INFO" | jq -r '.sha')
MANIFEST_CONTENT=$(echo "$MANIFEST_INFO" | jq -r '.content' | base64 -d)

# Remove the dossier from manifest
NEW_MANIFEST=$(echo "$MANIFEST_CONTENT" | jq --arg name "$DOSSIER_NAME" '.dossiers = [.dossiers[] | select(.name != $name)]')

# Commit updated manifest
NEW_MANIFEST_B64=$(echo "$NEW_MANIFEST" | base64 -w 0)

curl -s -X PUT \
  -H "Authorization: Bearer $GITHUB_BOT_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "$API/repos/$REPO/contents/index.json" \
  -d "{\"message\":\"Remove $DOSSIER_NAME from manifest\",\"content\":\"$NEW_MANIFEST_B64\",\"sha\":\"$MANIFEST_SHA\"}" | jq '{commit: .commit.sha}'

echo ""
echo "Done! Deleted: $DOSSIER_NAME"
