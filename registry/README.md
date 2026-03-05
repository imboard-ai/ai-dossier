# Dossier Registry

The registry API for discovering, searching, and publishing [Dossier](https://github.com/imboard-ai/ai-dossier) automation instructions.

## Canonical Instance

The official public registry is hosted at **https://dossier-registry.vercel.app** and operated by [ImBoard.ai](https://github.com/imboard-ai). This is the default registry used by the [`@ai-dossier/cli`](https://github.com/imboard-ai/ai-dossier) tool.

## Architecture

- **Platform**: Vercel Serverless Functions (Node.js)
- **Content storage**: [dossier-content](https://github.com/imboard-ai/dossier-content) GitHub repo
- **Content delivery**: jsDelivr CDN
- **Authentication**: GitHub OAuth + JWT
- **Database**: None -- uses a static `index.json` manifest

## API Endpoints

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |
| GET | `/api/v1/docs` | API documentation |
| GET | `/api/v1/dossiers` | List all dossiers (paginated) |
| GET | `/api/v1/dossiers/{name}` | Get dossier metadata |
| GET | `/api/v1/dossiers/{name}/content` | Get dossier content (markdown) |
| GET | `/api/v1/search?q=query` | Search dossiers |

### Authenticated (requires JWT)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/me` | Current user info |
| POST | `/api/v1/dossiers` | Publish a dossier |
| DELETE | `/api/v1/dossiers/{name}` | Delete a dossier |

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/login` | Start GitHub OAuth flow |
| GET | `/auth/callback` | OAuth callback, returns JWT |

## Development

```bash
# Install dependencies
npm install

# Run locally
vercel dev

# Deploy
vercel          # preview
vercel --prod   # production
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for signing JWT tokens |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GITHUB_BOT_TOKEN` | Token for committing to dossier-content repo |

## Related Projects

| Project | Description |
|---------|-------------|
| [ai-dossier](https://github.com/imboard-ai/ai-dossier) | Core library, CLI, and MCP server |
| [dossier-content](https://github.com/imboard-ai/dossier-content) | Content repository with all published dossiers |

## License

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE). You are free to use, copy, modify, and distribute it, with one restriction: you may not offer it as a hosted or managed service to third parties.

The canonical hosted instance at `dossier-registry.vercel.app` is operated exclusively by [ImBoard.ai](https://github.com/imboard-ai).
