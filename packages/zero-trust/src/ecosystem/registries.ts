/** Single source for registry addresses and lockfile hash formats, shared by
 * detection, the proxy policy, the rendered mirror configs and the fixture self-check. */

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** PyPI's simple index exactly as `uv.lock` records it (no trailing slash). */
export const PYPI_SIMPLE = 'https://pypi.org/simple';
export const PYPI_FILES_HOST = 'files.pythonhosted.org';

export const NPM_REGISTRY_HOST = new URL(NPM_REGISTRY).hostname;
export const PYPI_HOST = new URL(PYPI_SIMPLE).hostname;

/** npm `integrity`: a single sha512 Subresource Integrity value. */
export const NPM_SRI_SHA512 = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
/** uv `hash`: `sha256:` + 64 lowercase hex. */
export const UV_SHA256 = /^sha256:([a-f0-9]{64})$/;
/** pip `--hash` option with a sha256 digest. */
export const PIP_HASH_PREFIX = '--hash=sha256:';

/** The sdist and wheels a uv lock package entry records. */
export function uvArtifacts(pkg: Record<string, unknown>): unknown[] {
  return [
    ...(pkg.sdist === undefined ? [] : [pkg.sdist]),
    ...(Array.isArray(pkg.wheels) ? pkg.wheels : []),
  ];
}
