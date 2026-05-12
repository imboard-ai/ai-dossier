#!/bin/bash

# Dossier Tracing Integration - Verification Test Suite
# Run this after filling gaps to verify the integration works

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
pass() {
  echo -e "${GREEN}✅ PASS${NC}: $1"
  ((TESTS_PASSED++))
}

fail() {
  echo -e "${RED}❌ FAIL${NC}: $1"
  echo -e "${RED}   ${2}${NC}"
  ((TESTS_FAILED++))
}

info() {
  echo -e "${YELLOW}ℹ️  INFO${NC}: $1"
}

section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Configuration
API_URL="${API_URL:-http://localhost:3000}"
AUTH_TOKEN="${AUTH_TOKEN:-}"

if [ -z "$AUTH_TOKEN" ]; then
  info "No AUTH_TOKEN provided. Auth-required tests will be skipped."
  info "Set AUTH_TOKEN environment variable to test authenticated endpoints."
fi

# Test 1: Check if server is running
section "Test 1: Server Health"
if curl -s -f "$API_URL/api/traces" > /dev/null 2>&1 || \
   curl -s "$API_URL/api/traces" 2>&1 | grep -q "unauthorized\|401"; then
  pass "Server is responding"
else
  fail "Server is not responding" "Is 'npm run dev' running?"
  exit 1
fi

# Test 2: Unauthenticated request should return 401
section "Test 2: Authentication Required"
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/traces")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "401" ]; then
  pass "Unauthenticated requests correctly return 401"
elif echo "$BODY" | grep -q "unauthorized"; then
  pass "Unauthenticated requests correctly return 401"
else
  fail "Expected 401, got $HTTP_CODE" "Check auth middleware is working"
fi

# Remaining tests require authentication
if [ -z "$AUTH_TOKEN" ]; then
  info "Skipping authenticated tests (no AUTH_TOKEN provided)"
  section "Test Summary"
  echo "Tests Passed: $TESTS_PASSED"
  echo "Tests Failed: $TESTS_FAILED"
  echo ""
  echo "To run full test suite:"
  echo "  AUTH_TOKEN='your-token' ./test-integration.sh"
  exit 0
fi

# Test 3: Create a trace
section "Test 3: Create Trace"
TRACE_ID=$(uuidgen 2>/dev/null || echo "550e8400-e29b-41d4-a716-446655440000")
CREATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL/api/traces" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"trace_id\": \"$TRACE_ID\",
    \"dossier\": {
      \"title\": \"Test Dossier\",
      \"version\": \"1.0.0\",
      \"file_path\": \"/test/dossier.md\"
    },
    \"agent\": {
      \"name\": \"Test Agent\",
      \"version\": \"1.0.0\"
    },
    \"environment\": {
      \"user\": \"test-user\",
      \"hostname\": \"test-host\"
    },
    \"started_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
    \"status\": \"running\"
  }")

HTTP_CODE=$(echo "$CREATE_RESPONSE" | tail -n1)
BODY=$(echo "$CREATE_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  if echo "$BODY" | grep -q "$TRACE_ID"; then
    pass "Created trace successfully"
  else
    fail "Create returned 201 but no trace_id in response" "$BODY"
  fi
else
  fail "Failed to create trace (HTTP $HTTP_CODE)" "$BODY"
  TRACE_ID=""  # Clear so we skip dependent tests
fi

# Test 4: Retrieve the trace
if [ -n "$TRACE_ID" ]; then
  section "Test 4: Retrieve Trace"
  GET_RESPONSE=$(curl -s -w "\n%{http_code}" \
    "$API_URL/api/traces/$TRACE_ID" \
    -H "Authorization: Bearer $AUTH_TOKEN")

  HTTP_CODE=$(echo "$GET_RESPONSE" | tail -n1)
  BODY=$(echo "$GET_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    if echo "$BODY" | grep -q "\"trace_id\""; then
      pass "Retrieved trace successfully"
    else
      fail "Got 200 but response doesn't look like a trace" "$BODY"
    fi
  else
    fail "Failed to retrieve trace (HTTP $HTTP_CODE)" "$BODY"
  fi
fi

# Test 5: Append a step
if [ -n "$TRACE_ID" ]; then
  section "Test 5: Append Step"
  STEP_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$API_URL/api/traces/$TRACE_ID/steps" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"step_id\": \"step_001\",
      \"type\": \"action\",
      \"timestamp\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
      \"dossier_section\": \"Test Section\",
      \"description\": \"Test step\",
      \"action\": {
        \"type\": \"command\",
        \"command\": \"echo test\"
      },
      \"result\": {
        \"status\": \"success\",
        \"output\": \"test\",
        \"exit_code\": 0
      },
      \"duration_ms\": 100
    }")

  HTTP_CODE=$(echo "$STEP_RESPONSE" | tail -n1)
  BODY=$(echo "$STEP_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    if echo "$BODY" | grep -q "step_number"; then
      pass "Appended step successfully"
    else
      fail "Got 201 but response doesn't contain step_number" "$BODY"
    fi
  else
    fail "Failed to append step (HTTP $HTTP_CODE)" "$BODY"
  fi
fi

# Test 6: Update trace (mark complete)
if [ -n "$TRACE_ID" ]; then
  section "Test 6: Update Trace"
  UPDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X PATCH "$API_URL/api/traces/$TRACE_ID" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"status\": \"success\",
      \"completed_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
      \"duration_ms\": 5000
    }")

  HTTP_CODE=$(echo "$UPDATE_RESPONSE" | tail -n1)
  BODY=$(echo "$UPDATE_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    if echo "$BODY" | grep -q "updated_at"; then
      pass "Updated trace successfully"
    else
      fail "Got 200 but response doesn't contain updated_at" "$BODY"
    fi
  else
    fail "Failed to update trace (HTTP $HTTP_CODE)" "$BODY"
  fi
fi

# Test 7: List traces
section "Test 7: List Traces"
LIST_RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$API_URL/api/traces" \
  -H "Authorization: Bearer $AUTH_TOKEN")

HTTP_CODE=$(echo "$LIST_RESPONSE" | tail -n1)
BODY=$(echo "$LIST_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  if echo "$BODY" | grep -q "\"traces\""; then
    pass "Listed traces successfully"
  else
    fail "Got 200 but response doesn't contain traces array" "$BODY"
  fi
else
  fail "Failed to list traces (HTTP $HTTP_CODE)" "$BODY"
fi

# Test 8: Filter traces by dossier
section "Test 8: Filter Traces"
FILTER_RESPONSE=$(curl -s -w "\n%{http_code}" \
  "$API_URL/api/traces?dossier=Test%20Dossier" \
  -H "Authorization: Bearer $AUTH_TOKEN")

HTTP_CODE=$(echo "$FILTER_RESPONSE" | tail -n1)
BODY=$(echo "$FILTER_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  if echo "$BODY" | grep -q "\"traces\""; then
    pass "Filtered traces successfully"
  else
    fail "Got 200 but response doesn't contain traces array" "$BODY"
  fi
else
  fail "Failed to filter traces (HTTP $HTTP_CODE)" "$BODY"
fi

# Test 9: Delete trace (cleanup)
if [ -n "$TRACE_ID" ]; then
  section "Test 9: Delete Trace (Cleanup)"
  DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X DELETE "$API_URL/api/traces/$TRACE_ID" \
    -H "Authorization: Bearer $AUTH_TOKEN")

  HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)

  if [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "200" ]; then
    pass "Deleted trace successfully"
  else
    fail "Failed to delete trace (HTTP $HTTP_CODE)" "Trace may remain in database"
  fi
fi

# Summary
section "Test Summary"
echo ""
echo "Tests Passed: $TESTS_PASSED"
echo "Tests Failed: $TESTS_FAILED"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
  echo ""
  echo "Integration is working correctly!"
  echo "Ready to deploy: vercel deploy --prod"
  exit 0
else
  echo -e "${RED}❌ SOME TESTS FAILED${NC}"
  echo ""
  echo "Please review failures and fix before deploying."
  exit 1
fi
