#!/bin/bash
# Generate OAuth authorization URL without exposing secrets in terminal output
# Usage: ./scripts/auth-url.sh [local|prod]

ENV="${1:-prod}"

# Load shared config
source "$(dirname "$0")/config.sh"

# Load environment variables
if [ -f .env.local ]; then
  export $(grep GITHUB_CLIENT_ID .env.local | xargs)
fi

if [ -z "$GITHUB_CLIENT_ID" ]; then
  echo "Error: GITHUB_CLIENT_ID not found in .env.local"
  echo "Run: vercel env pull .env.local"
  exit 1
fi

if [ "$ENV" = "local" ]; then
  REDIRECT_URI="http://localhost:3000/auth/callback"
else
  REDIRECT_URI="${PRODUCTION_URL}/auth/callback"
fi

SCOPES="read:user%20read:org"
URL="https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}"

echo ""
echo "Opening OAuth URL in browser..."
echo ""

# Try to open in browser (works on macOS, Linux with xdg-open, WSL)
if command -v xdg-open &> /dev/null; then
  xdg-open "$URL" 2>/dev/null
elif command -v open &> /dev/null; then
  open "$URL"
elif command -v wslview &> /dev/null; then
  wslview "$URL"
else
  echo "Could not open browser automatically."
  echo "Copy this URL and open it manually:"
  echo ""
  echo "$URL"
fi
