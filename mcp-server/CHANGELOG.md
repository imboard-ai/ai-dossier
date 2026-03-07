# Changelog

All notable changes to `@ai-dossier/mcp-server` will be documented in this file.

## [1.0.3] - 2026-03-07

### Changed
- Excluded test files and stale artifacts from npm package
- Added clean build step (`rm -rf dist` before `tsc`)
- Added `.npmignore` for defense-in-depth package filtering
- Added LICENSE to published package
- Added MCP Registry metadata (`server.json`, `mcpName`)

## [1.0.2] - 2026-03-07

### Fixed
- Updated `engines.node` to `>=20.0.0` (vitest v4 + vite v7 require Node 20+)
- Rewrote README to match actual implemented tools, resources, and prompts

## [1.0.1] - 2026-02-28

### Added
- Multi-dossier orchestration: `resolve_graph`, `verify_graph`, `start_journey`, `step_complete`, `get_journey_status`, `cancel_journey` tools
- `search_dossiers` tool for registry search
- `execute-journey` prompt for guided multi-step execution
- `dossier://orchestration` resource with full orchestration reference
- DAG-based dependency resolution with parallel group detection and conflict checking
- Journey session management with context injection between steps

## [1.0.0] - 2026-01-15

### Added
- Initial release
- Core tools: `verify_dossier`, `read_dossier`, `list_dossiers`
- Resources: `dossier://protocol`, `dossier://security`, `dossier://concept`
- Prompts: `execute-dossier`, `create-dossier`
- SHA256 checksum verification
- Minisign signature verification
- Risk assessment and trust model
- Structured logging
- stdio transport for Claude Code / Claude Desktop integration
