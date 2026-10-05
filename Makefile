# Dossier Build System
# Handles build order dependencies across npm workspaces

.PHONY: all build build-all clean test test-coverage install help lint format check build-pool build-sched build-vscode build-binary build-zero-trust
.DEFAULT_GOAL := help

## help: Show this help message
help:
	@echo "Dossier Build System"
	@echo ""
	@echo "Available targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -E 's/## ([^:]+): (.+)/  \1: \2/'
	@echo ""
	@echo "Build order:"
	@echo "  1. packages/core (TypeScript → dist/)"
	@echo "  2. packages/worktree-pool (TypeScript → dist/)"
	@echo "  3. packages/sched (TypeScript → dist/, depends on core + worktree-pool)"
	@echo "  4. mcp-server (TypeScript → dist/, depends on core)"
	@echo "  5. cli (TypeScript → dist/, depends on core + sched)"
	@echo "  6. registry (TypeScript, deployed via Vercel, depends on core)"

## install: Install all npm dependencies
install:
	@echo "Installing dependencies..."
	npm install
	@echo "✓ Dependencies installed"

## build: Lint then build all packages (for local development)
build: lint build-all

## build-all: Build all packages in dependency order (no lint)
build-all: build-core build-pool build-sched build-zero-trust build-mcp build-cli build-vscode
	@echo "✓ All packages built successfully"

## build-core: Build @ai-dossier/core package
build-core:
	@echo "Building packages/core..."
	cd packages/core && npm run build
	@echo "✓ packages/core built"

## build-mcp: Build mcp-server (depends on core)
build-mcp: build-core
	@echo "Building mcp-server..."
	cd mcp-server && npm run build
	@echo "✓ mcp-server built"

## build-cli: Build CLI (depends on core + sched)
build-cli: build-core build-sched
	@echo "Building CLI..."
	cd cli && npm run build
	@echo "✓ cli built"

## build-vscode: Typecheck and bundle the VS Code extension (depends on core)
build-vscode: build-core
	@echo "Building packages/vscode..."
	cd packages/vscode && npm run typecheck && npm run build
	@echo "✓ packages/vscode built"

## build-pool: Build @ai-dossier/worktree-pool package
build-pool:
	@echo "Building packages/worktree-pool..."
	cd packages/worktree-pool && npm run build
	@echo "✓ packages/worktree-pool built"

## build-sched: Build @ai-dossier/sched package
build-sched: build-core build-pool
	@echo "Building packages/sched..."
	cd packages/sched && npm run build
	@echo "✓ packages/sched built"

## build-zero-trust: Build private provider-independent zero-trust foundation
build-zero-trust:
	@echo "Building packages/zero-trust..."
	cd packages/zero-trust && npm run build
	@echo "✓ packages/zero-trust built"

## build-binary: Build a standalone (no-Node) ai-dossier executable for this host into dist-binaries/
build-binary: build-cli
	node scripts/build-sea.mjs

## clean: Remove all build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf packages/core/dist
	rm -rf packages/worktree-pool/dist
	rm -rf packages/sched/dist
	rm -rf packages/zero-trust/dist
	rm -rf mcp-server/dist
	rm -rf cli/dist
	@echo "✓ Build artifacts cleaned"

## rebuild: Clean and rebuild all packages
rebuild: clean build

## test: Run tests across all packages and repo scripts
test:
	@echo "Running tests..."
	npm run test --workspaces --if-present
	npm run test:scripts
	@echo "✓ Tests completed"

## test-coverage: Run tests (packages with coverage + repo scripts) and enforce thresholds
test-coverage:
	@echo "Running tests with coverage..."
	npm run test:coverage --workspaces --if-present
	npm run test:scripts
	@echo "✓ Tests with coverage completed"

## lint: Check code for linting issues, warnings included, same as CI (no changes)
lint:
	@echo "Checking code with Biome..."
	npm run lint

## format: Format code with Biome
format:
	@echo "Formatting code with Biome..."
	npm run format
	@echo "✓ Code formatted"

## check: Format and lint code with auto-fix; fails if a warning remains
check:
	@echo "Checking and fixing code with Biome..."
	npm run check
	@echo "✓ Code checked and formatted"

## verify: Verify a dossier file (usage: make verify FILE=path/to/file.ds.md)
verify:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make verify FILE=path/to/file.ds.md"; \
		exit 1; \
	fi
	node cli/dist/cli.js verify "$(FILE)"

## dev: Watch mode for development (builds core on change)
dev:
	@echo "Starting development mode..."
	cd packages/core && npm run dev

## all: Install, build, and test everything
all: install build test
	@echo "✓ Complete build successful"
