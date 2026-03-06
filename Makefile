# Dossier Build System
# Handles build order dependencies across npm workspaces

.PHONY: all build clean test test-coverage install help lint format check
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
	@echo "  2. mcp-server (TypeScript → dist/, depends on core)"
	@echo "  3. cli (TypeScript → dist/)"
	@echo "  4. registry (TypeScript, deployed via Vercel, depends on core)"

## install: Install all npm dependencies
install:
	@echo "Installing dependencies..."
	npm install
	@echo "✓ Dependencies installed"

## build: Build all packages in dependency order
build: lint build-core build-mcp build-cli
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

## build-cli: Build CLI (depends on core)
build-cli: build-core
	@echo "Building CLI..."
	cd cli && npm run build
	@echo "✓ cli built"

## clean: Remove all build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf packages/core/dist
	rm -rf mcp-server/dist
	rm -rf cli/dist
	@echo "✓ Build artifacts cleaned"

## rebuild: Clean and rebuild all packages
rebuild: clean build

## test: Run tests across all packages
test:
	@echo "Running tests..."
	npm run test --workspaces --if-present
	@echo "✓ Tests completed"

## test-coverage: Run tests with coverage reporting and threshold enforcement
test-coverage:
	@echo "Running tests with coverage..."
	npm run test:coverage --workspaces --if-present
	@echo "✓ Tests with coverage completed"

## lint: Check code for linting issues (no changes)
lint:
	@echo "Checking code with Biome..."
	npx biome check .

## format: Format code with Biome
format:
	@echo "Formatting code with Biome..."
	npx biome format --write .
	@echo "✓ Code formatted"

## check: Format and lint code with auto-fix
check:
	@echo "Checking and fixing code with Biome..."
	npx biome check --write .
	@echo "✓ Code checked and formatted"

## verify: Verify a dossier file (usage: make verify FILE=path/to/file.ds.md)
verify:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make verify FILE=path/to/file.ds.md"; \
		exit 1; \
	fi
	node cli/bin/dossier-verify "$(FILE)"

## dev: Watch mode for development (builds core on change)
dev:
	@echo "Starting development mode..."
	cd packages/core && npm run dev

## all: Install, build, and test everything
all: install build test
	@echo "✓ Complete build successful"
