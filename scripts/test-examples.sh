#!/usr/bin/env bash
# ------------------------------------------------------------------
# test-examples.sh
#
# Finds every .ds.md file under examples/ and runs:
#   1. `dossier validate`        -- frontmatter structure validation
#   2. `dossier checksum --verify` -- SHA256 integrity check
#
# Uses `checksum --verify` instead of the full `verify` pipeline
# because CI has no trusted-keys setup, so signature trust checks
# would always BLOCK signed dossiers.
#
# Exit code 0 only when every dossier passes both checks.
# ------------------------------------------------------------------

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node ${REPO_ROOT}/cli/dist/cli.js"
EXAMPLES_DIR="${REPO_ROOT}/examples"

passed=0
failed=0
failures=()

# Collect all .ds.md files
mapfile -t dossier_files < <(find "$EXAMPLES_DIR" -name '*.ds.md' -type f | sort)

if [ ${#dossier_files[@]} -eq 0 ]; then
  echo "ERROR: No .ds.md files found in ${EXAMPLES_DIR}"
  exit 1
fi

echo "============================================"
echo "  Dossier Example Tests"
echo "============================================"
echo ""
echo "Found ${#dossier_files[@]} dossier(s) in examples/"
echo ""

for file in "${dossier_files[@]}"; do
  relative="${file#"${REPO_ROOT}/"}"
  echo "--- ${relative} ---"

  file_ok=true

  # 1. Validate (frontmatter structure)
  if $CLI validate "$file" --quiet 2>&1; then
    echo "  validate:  PASS"
  else
    echo "  validate:  FAIL"
    file_ok=false
  fi

  # 2. Checksum (SHA256 integrity)
  if $CLI checksum --verify "$file" 2>&1; then
    echo "  checksum:  PASS"
  else
    echo "  checksum:  FAIL"
    file_ok=false
  fi

  if $file_ok; then
    ((passed++))
  else
    ((failed++))
    failures+=("$relative")
  fi

  echo ""
done

# Summary
echo "============================================"
echo "  Summary"
echo "============================================"
echo "  Total:  ${#dossier_files[@]}"
echo "  Passed: ${passed}"
echo "  Failed: ${failed}"

if [ ${#failures[@]} -gt 0 ]; then
  echo ""
  echo "  Failures:"
  for f in "${failures[@]}"; do
    echo "    - ${f}"
  done
fi
echo "============================================"

if [ "$failed" -gt 0 ]; then
  exit 1
fi

echo ""
echo "All example dossiers passed."
exit 0
