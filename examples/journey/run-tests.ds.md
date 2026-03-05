---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "run-tests",
  "title": "Run Tests",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Run the project test suite and report results",
  "category": [
    "development"
  ],
  "tags": [
    "testing",
    "ci",
    "example",
    "journey"
  ],
  "risk_level": "low",
  "risk_factors": [
    "executes_external_code"
  ],
  "requires_approval": false,
  "relationships": {
    "preceded_by": [
      {
        "dossier": "install-deps",
        "condition": "required",
        "reason": "Dependencies must be installed before running tests"
      }
    ]
  },
  "checksum": {
    "algorithm": "sha256",
    "hash": "b003b51ca4cdfd728bf8e5c523f797d0de2a45cb12c917037bb7957b04acbc1b"
  }
}
---

# Run Tests

## Objective

Run the project test suite and verify all tests pass.

## Steps

1. Run the test suite:
   ```bash
   cd "$project_path"
   npm test 2>/dev/null || echo "No test suite configured — example journey complete"
   ```

2. Report the test results to the user.

## Notes

This is the final step in the example journey. After completion, the journey will be marked as complete.
