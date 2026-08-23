# Fix for #434

**Issue:** worktree-pool: `claim --issue 0` rejected as missing (falsy check)

**Analysis:**
`npx worktree-pool claim --issue 0 --branch x` fails with "--issue N and --branch B are required" because the arg check treats 0 as missing. Use an explicit undefined/NaN check. Found while smoke-testing 0.5.0 on imboard-monorepo (imboard-ai/imboard-monorepo#3686).

**Fix applied:** Automated fix attempt via bot. Requires manual review.
