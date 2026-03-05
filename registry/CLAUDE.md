# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dossier Registry MVP - A serverless API deployed on Vercel. Currently at MVP0 stage with a minimal health check endpoint.

## Architecture

- **Platform**: Vercel Serverless Functions
- **Runtime**: Node.js
- **API Structure**: `/api/v1/` - Versioned API endpoints as individual serverless functions

Each file in `api/v1/` becomes an endpoint at `/api/v1/<filename>` (e.g., `api/v1/health.js` → `/api/v1/health`).

## Development

### Local Development
```bash
vercel dev
```
Runs the development server on http://localhost:3000

### Testing Endpoints
Use the HTTP test files in `tests/http/` with VS Code REST Client or similar:
```
tests/http/local.http
```

### Deployment
```bash
vercel          # Preview deployment
vercel --prod   # Production deployment
```

## API Endpoints

- `GET /api/v1/health` - Health check endpoint returning service status
