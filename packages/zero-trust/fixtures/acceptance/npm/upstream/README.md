# ztfc-upstream-fixture

A **test fixture** for the zero-trust contribution workflow in
[imboard-ai/ai-dossier](https://github.com/imboard-ai/ai-dossier). It plays the role of a
third-party open-source project during the live acceptance demonstration
([ai-dossier#1115](https://github.com/imboard-ai/ai-dossier/issues/1115)).

`toSeconds(text)` in `src/duration.js` converts a human duration such as `"90s"` or `"2m"` to
whole seconds, using the [`ms`](https://www.npmjs.com/package/ms) package.

This is not a real library. See `CONTRIBUTING.md` for how changes are proposed here.
