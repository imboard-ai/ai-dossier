# Setting Up Dossier MCP Server with Claude Code

This guide walks you through configuring the Dossier MCP Server to work with Claude Code.

## Prerequisites

- Node.js 20+ installed
- Claude Code installed
- Git repository cloned to your local machine

## Step 1: Build the MCP Server

From the `mcp-server/` directory:

```bash
cd /path/to/dossier/mcp-server
npm install
npm run build
```

Verify the build succeeded:
```bash
ls -la dist/
# Should see index.js and other compiled files
```

## Step 2: Get Absolute Paths

You'll need the absolute path to your dossier project:

```bash
pwd
# Example output: /home/username/projects/dossier
```

## Step 3: Configure Claude Code

1. **Open Claude Code Settings**
   - Click the gear icon or press `Cmd/Ctrl + ,`
   - Navigate to Extensions → MCP Servers

2. **Add MCP Server Configuration**

   Click "Edit in settings.json" and add:

   ```json
   {
     "mcpServers": {
       "dossier": {
         "command": "node",
         "args": ["/home/username/projects/dossier/mcp-server/dist/index.js"],
         "cwd": "/home/username/projects/dossier"
       }
     }
   }
   ```

   **Important**: Replace `/home/username/projects/dossier` with your actual path!

3. **Save and Restart Claude Code**

## Step 4: Verify Installation

In Claude Code, try these commands:

### Test 1: List Dossiers
```
List all dossiers in the examples directory
```

Expected: Claude should use the `list_dossiers` tool and show all 5 example dossiers.

### Test 2: Verify Security
```
Verify the security of examples/development/add-git-worktree-support.ds.md
```

Expected: Claude should use the `verify_dossier` tool and show:
- Integrity: valid (checksum matches)
- Authenticity: unsigned
- Risk Level: high
- Recommendation: WARN

### Test 3: Read Protocol
```
Read the dossier://protocol resource
```

Expected: Claude should access the protocol resource and show PROTOCOL.md content.

## Step 5: Test Full Workflow

Try executing a dossier (simulation):

```
I want to run the add-git-worktree-support dossier.
First verify its security, then show me what it will do.
```

Expected workflow:
1. Claude calls `verify_dossier` → Shows security report
2. Claude asks for your approval (high risk)
3. Claude calls `read_dossier` → Gets dossier content
4. Claude explains the actions without executing

## Troubleshooting

### Server Not Starting

**Problem**: Claude Code can't connect to MCP server

**Solution**:
1. Check logs in Claude Code console
2. Verify paths are absolute (not relative)
3. Ensure `dist/index.js` exists (run `npm run build`)
4. Try running manually: `node /path/to/mcp-server/dist/index.js`

### "Unknown tool" Error

**Problem**: Claude can't find `verify_dossier` or other tools

**Solution**:
1. Restart Claude Code after config changes
2. Check MCP server logs (stderr)
3. Verify server is registered in settings

### Path Issues on Windows

**Problem**: Backslashes in Windows paths

**Solution**: Use forward slashes or double backslashes:
```json
{
  "command": "node",
  "args": ["C:/Users/username/projects/dossier/mcp-server/dist/index.js"],
  "cwd": "C:/Users/username/projects/dossier"
}
```

### minisign Not Found

**Problem**: Signature verification fails with "minisign not found"

**Solution**: Install minisign:
- macOS: `brew install minisign`
- Linux: `apt-get install minisign` or `yum install minisign`
- Windows: Download from https://jedisct1.github.io/minisign/

**Note**: Signature verification is optional. Unsigned dossiers will show as WARN but can still be used.

## Logging

All logs are written to stderr in JSON format. To see them:

1. **In Claude Code**: Check the Output panel → MCP Servers
2. **Manual testing**: Logs will appear in terminal when running server directly

Example log:
```json
{"timestamp":"2025-11-07T12:42:22.663Z","level":"info","message":"Starting dossier verification","context":{"dossierFile":"..."}}
```

## Configuration Reference

### Full Configuration Example

```json
{
  "mcpServers": {
    "dossier": {
      "command": "node",
      "args": ["/absolute/path/to/dossier/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/dossier",
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

### Environment Variables

- `LOG_LEVEL`: Set to `debug` for verbose logging (default: `info`)

## Next Steps

Once everything is working:

1. Try verifying all example dossiers
2. Test with your own project's dossiers
3. Explore resources: `dossier://protocol`, `dossier://security`, `dossier://concept`
4. Provide feedback on what works and what doesn't!

## Getting Help

- **Issues**: https://github.com/imboard-ai/ai-dossier/issues
- **Discussions**: https://github.com/imboard-ai/ai-dossier/discussions
- **Documentation**: https://github.com/imboard-ai/ai-dossier/tree/main/docs

---

**Status**: MVP complete, ready for testing! We'd love your feedback.
