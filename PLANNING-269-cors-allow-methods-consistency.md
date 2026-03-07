# Issue #269: Review: Documentation findings from fix/225-docs-cors-security-findings

## Type
fix

## Problem Statement
The CORS `Access-Control-Allow-Methods` header lists `GET, POST, DELETE, OPTIONS, HEAD` but the `MUTATING_METHODS` set includes `POST, PUT, PATCH, DELETE`. The API design doc defines PUT endpoints for Prod0/Prod1 phases. The Allow-Methods header and design doc CORS section need to include `PUT` and `PATCH` for forward compatibility.

## Implementation Checklist
- [ ] Understand the current CORS config in registry/lib/cors.ts
- [ ] Review the API design doc for future PUT/PATCH endpoints
- [ ] Add PUT and PATCH to the Access-Control-Allow-Methods header
- [ ] Update CORS documentation section in the design doc if needed
- [ ] Run tests
- [ ] Self-review

## Files to Modify
- registry/lib/cors.ts (ALLOWED_METHODS)
- registry/docs/planning/registry-api-design.md (CORS section)

## Testing Strategy
- [ ] Unit tests for CORS middleware
- [ ] Verify build passes
