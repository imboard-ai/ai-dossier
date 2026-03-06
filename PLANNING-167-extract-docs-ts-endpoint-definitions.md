# Issue #167: Review: Maintainability — extract docs.ts endpoint definitions

## Type
feature (refactor)

## Problem Statement
The `handler` function in `registry/api/v1/docs.ts` is ~190 lines long (4x the 50-line threshold). The entire API documentation response is a single inline object literal, making it hard to update individual endpoint docs without risk of breaking the JSON structure.

Additionally, the version string `'MVP1'` is hardcoded on line 17 — should be extracted to a shared constant.

## Implementation Checklist
- [ ] Extract endpoint documentation into named constants or per-endpoint descriptor objects
- [ ] Extract `'MVP1'` version string to a shared constant
- [ ] Ensure `health.ts` also uses the shared constant
- [ ] Verify the API response is unchanged
- [ ] Add/update tests

## Files to Modify
- `registry/api/v1/docs.ts` — main refactor target
- `registry/api/v1/health.ts` — share version constant
- Possibly a new constants file

## Testing Strategy
- [ ] Unit tests for the docs handler
- [ ] Verify response structure matches original
