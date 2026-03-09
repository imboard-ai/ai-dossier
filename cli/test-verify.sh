#!/bin/bash
# Dossier CLI Test Script
# Tests Ed25519 signature verification

set -e

echo "🧪 Dossier CLI Verification Tests"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Test 1: Ed25519 Signed Dossier
echo "Test 1: Ed25519 Signature Verification"
echo "---------------------------------------"
TESTS_RUN=$((TESTS_RUN + 1))

# Add test key to trusted keys temporarily
TRUSTED_KEYS_DIR="$HOME/.dossier"
TRUSTED_KEYS_FILE="$TRUSTED_KEYS_DIR/trusted-keys.txt"
BACKUP_KEYS_FILE="$TRUSTED_KEYS_DIR/trusted-keys.txt.backup"

# Backup existing trusted keys if they exist
if [ -f "$TRUSTED_KEYS_FILE" ]; then
  cp "$TRUSTED_KEYS_FILE" "$BACKUP_KEYS_FILE"
fi

# Create trusted keys directory if it doesn't exist
mkdir -p "$TRUSTED_KEYS_DIR"

# Add test key_id to trusted keys
# Using key_id is simpler than full PEM public key
TEST_KEY_ID="test-key-2025"

# Write test key to trusted keys (preserving existing keys)
if [ -f "$TRUSTED_KEYS_FILE" ]; then
  # Append test key if not already present
  if ! grep -q "$TEST_KEY_ID" "$TRUSTED_KEYS_FILE" 2>/dev/null; then
    echo "$TEST_KEY_ID test-suite" >> "$TRUSTED_KEYS_FILE"
  fi
else
  echo "$TEST_KEY_ID test-suite" > "$TRUSTED_KEYS_FILE"
fi

# Run Ed25519 test
if node bin/dossier-verify ../examples/test/hello-world.ds.md > /dev/null 2>&1; then
  echo -e "${GREEN}✓ PASSED${NC} - Ed25519 signature verified successfully"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "${RED}✗ FAILED${NC} - Ed25519 signature verification failed"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

# Restore original trusted keys
if [ -f "$BACKUP_KEYS_FILE" ]; then
  mv "$BACKUP_KEYS_FILE" "$TRUSTED_KEYS_FILE"
else
  rm -f "$TRUSTED_KEYS_FILE"
fi

echo ""
echo "=================================="
echo "Test Results Summary"
echo "=================================="
echo "Total tests run: $TESTS_RUN"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ Some tests failed${NC}"
  exit 1
fi
