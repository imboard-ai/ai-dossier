---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Set Up Dossier MCP Server",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2025-11-07",
  "objective": "Configure Claude Code to use the dossier MCP server for streamlined, secure dossier execution with automatic verification and discovery",
  "category": [
    "setup"
  ],
  "tags": [
    "mcp",
    "configuration",
    "setup",
    "first-time"
  ],
  "estimated_duration": {
    "min_minutes": 5,
    "max_minutes": 15
  },
  "risk_level": "low",
  "risk_factors": [
    "modifies_files"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates or modifies ~/.claude/settings.local.json configuration file"
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "15bd10b56c4f14f368429942e29a27a8bbfe53109055fcef3bb6e845105563f7"
  },
  "mcp_integration": {
    "required": false,
    "fallback": "manual_execution",
    "benefits": [
      "This dossier sets up MCP integration (does not require it)"
    ]
  },
  "tools_required": [
    {
      "name": "node",
      "version": "18+",
      "check_command": "node --version",
      "install_url": "https://nodejs.org/"
    },
    {
      "name": "npm",
      "check_command": "npm --version",
      "install_url": "https://nodejs.org/"
    }
  ],
  "signature": {
    "algorithm": "ECDSA-SHA-256",
    "signature": "MEYCIQDwQ/xpSUaTF3eR+Hvp7rchSDp22Md/1KgleDAeWp7oiwIhAKe2BvwGiWkHNRzAfwOaHbpLryG82TboZRD1sj//GVGj",
    "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqIbQGqW1Jdh97TxQ5ZvnSVvvOcN5NWhfWwXRAaDDuKK1pv8F+kz+uo1W8bNn+8ObgdOBecFTFizkRa/g+QJ8kA==",
    "key_id": "arn:aws:kms:us-east-1:942039714848:key/d9ccd3fc-b190-49fd-83f7-e94df6620c1d",
    "signed_at": "2025-11-16T11:23:34.426Z",
    "signed_by": "Dossier Team <team@dossier.ai>"
  }
}
---
# Dossier: Set Up Dossier MCP Server

## Objective

Configure Claude Code to use the dossier MCP server, enabling:
- ⚡ **Automatic security verification** (checksums, signatures)
- 📋 **Dossier discovery** (list available dossiers)
- 🔒 **Trust management** (verify dossier authenticity)
- 🚀 **Streamlined execution** (no manual file reading)
- 📖 **Protocol access** (built-in documentation)

This is a **one-time setup** that enhances all future dossier executions.

---

## Prerequisites

### Required

- **Claude Code** installed and running
- **Node.js 20+** and npm installed
  - Check: `node --version` and `npm --version`
  - If missing: https://nodejs.org/
- **Text editor** to edit JSON configuration files
- **Basic terminal** familiarity

### Verification

Let me verify your prerequisites:

```bash
node --version
npm --version
```

If both commands return version numbers (e.g., `v20.x.x` and `10.x.x`), you're ready!

If either fails, please install Node.js from https://nodejs.org/ and restart this dossier.

---

## Context to Gather

### 1. Configuration File Location

Determine where to create the MCP configuration:

**Primary location** (recommended):
- `~/.claude/settings.local.json`

**Alternative locations**:
- `.claude/settings.local.json` (project-specific)
- `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS legacy)

Let me help you check which to use:

```bash
# Check if ~/.claude exists
ls -la ~/.claude 2>/dev/null || echo "Directory doesn't exist yet (will create)"

# Check if configuration already exists
cat ~/.claude/settings.local.json 2>/dev/null || echo "No configuration yet (will create new)"
```

**Decision**: We'll use `~/.claude/settings.local.json` (standard location)

### 2. Existing MCP Configuration

Check if you already have MCP servers configured:

```bash
cat ~/.claude/settings.local.json 2>/dev/null | grep -A 5 "mcpServers" || echo "No MCP configuration found"
```

**If dossier server already configured**: This setup is complete! Skip to Validation section.

**If other MCP servers exist**: We'll add dossier server to existing configuration.

**If no configuration exists**: We'll create a new configuration file.

---

## Decision Points

### Installation Method

**Question**: How do you want to run the dossier MCP server?

#### Option A: npx (Recommended) ⭐

**How it works**:
- No explicit installation step
- npm automatically downloads and caches the package
- Always uses latest published version
- Works across all projects

**Configuration**:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

**Pros**:
- ✅ Easiest setup (no npm install needed)
- ✅ Auto-updates to latest version
- ✅ Works if you have npm

**Cons**:
- ⚠️ First run downloads package (1-2 seconds delay)
- ⚠️ Requires internet connection for first run

**Recommended for**: Most users

---

#### Option B: Global Install

**How it works**:
- Explicitly install MCP server globally
- Available system-wide
- Fixed version until you update

**Installation**:
```bash
npm install -g @ai-dossier/mcp-server
```

**Configuration**:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "dossier-mcp-server"
    }
  }
}
```

**Pros**:
- ✅ Simpler configuration
- ✅ No download delay on first run
- ✅ Explicit version control

**Cons**:
- ⚠️ Requires installation step
- ⚠️ Manual updates needed
- ⚠️ Potential PATH issues on Windows

**Recommended for**: Users who want explicit control

---

#### Option C: Local Development (Advanced)

**How it works**:
- Use the built MCP server from dossier repository
- For developers working on dossier itself

**Configuration**:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "node",
      "args": ["/absolute/path/to/dossier/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/dossier"
    }
  }
}
```

**Recommended for**: Dossier contributors only

---

### Your Choice

**Which method do you prefer?**

1. npx (recommended) - automatic, always latest
2. global install - explicit control
3. local development - for contributors

**[User input needed]**

Based on your choice, I'll proceed with the appropriate configuration.

---

## Actions to Perform

### Step 1: Create Configuration Directory

If `~/.claude` doesn't exist, create it:

```bash
mkdir -p ~/.claude
```

### Step 2: Prepare Configuration

Based on your chosen installation method, create the configuration.

**If choosing npx** (Option A):

I'll create this configuration:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

**If choosing global install** (Option B):

First, install the package:
```bash
npm install -g @ai-dossier/mcp-server
```

Then I'll create this configuration:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "dossier-mcp-server"
    }
  }
}
```

### Step 3: Write Configuration File

**Important**: Let me check if you have existing MCP configuration first to avoid overwriting it.

```bash
if [ -f ~/.claude/settings.local.json ]; then
  echo "Existing configuration found. I'll help you merge."
  cat ~/.claude/settings.local.json
else
  echo "No existing configuration. Creating new file."
fi
```

**If no existing file**, I'll create:

```bash
cat > ~/.claude/settings.local.json << 'EOF'
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
EOF
```

**If existing file**, I'll guide you to manually add the dossier server configuration:

1. Open `~/.claude/settings.local.json` in your editor
2. Find the `"mcpServers"` object
3. Add dossier configuration:
   ```json
   "dossier": {
     "command": "npx",
     "args": ["-y", "@ai-dossier/mcp-server"]
   }
   ```
4. Ensure JSON is valid (no trailing commas, proper brackets)
5. Save the file

### Step 4: Restart Claude Code

**Critical**: Configuration changes require Claude Code restart.

1. Save all your work
2. Quit Claude Code completely (Cmd+Q / Ctrl+Q)
3. Restart Claude Code

### Step 5: Verify MCP Server Loaded

After restart, check if MCP server is running:

**Method 1**: Check Claude Code UI
- Look for MCP servers indicator
- Should see "dossier" in the list

**Method 2**: Test with a command
- Try: "list available dossiers"
- Should see dossiers in current project

---

## Validation

### Success Criteria

✅ MCP server appears in Claude Code's MCP servers list
✅ Can call `list_dossiers` tool successfully
✅ Can read `dossier://protocol` resource
✅ Can verify dossiers with `verify_dossier` tool

### Verification Steps

**Test 1: List Dossiers**

Try saying:
```
"List available dossiers in the examples directory"
```

**Expected Result**:
You should see a list of example dossiers with metadata (title, risk level, objective).

**If successful**: ✅ MCP server is working!

**If fails**: See Troubleshooting section below.

---

**Test 2: Read Protocol Resource**

Try saying:
```
"Read the dossier://protocol resource"
```

**Expected Result**:
You should see the dossier execution protocol documentation.

**If successful**: ✅ Resources are accessible!

---

**Test 3: Verify Security**

Try saying:
```
"Verify the security of examples/development/add-git-worktree-support.ds.md"
```

**Expected Result**:
You should see a security report with:
- Integrity: valid (checksum matches)
- Authenticity: unsigned
- Risk assessment: high
- Recommendation: WARN

**If successful**: ✅ Security verification is working!

---

### All Tests Passed?

🎉 **Congratulations!** Your dossier MCP server is fully configured and working.

You can now:
- Execute any dossier with automatic security verification
- Discover dossiers using natural language
- Access built-in protocol documentation
- Trust that checksums are verified automatically

---

## Troubleshooting

### Issue: "Tool not found" Error

**Symptom**: Claude Code says it doesn't have access to `list_dossiers` or other tools.

**Possible Causes**:
1. MCP server not configured
2. Claude Code not restarted
3. Configuration syntax error

**Solutions**:

**Check 1**: Verify configuration file exists
```bash
cat ~/.claude/settings.local.json
```

Should show JSON with `mcpServers` and `dossier` entry.

**Check 2**: Verify JSON syntax
```bash
cat ~/.claude/settings.local.json | python3 -m json.tool
```

If this fails, you have invalid JSON. Common issues:
- Trailing commas
- Missing quotes
- Unmatched brackets

**Check 3**: Restart Claude Code
- Quit completely (not just close window)
- Restart
- Wait 5-10 seconds for MCP servers to load

---

### Issue: "command not found: npx" (Option A users)

**Symptom**: Error says npx command doesn't exist.

**Cause**: npm not installed or not in PATH.

**Solution**:

**Check 1**: Verify npm installation
```bash
which npm
npm --version
```

If npm not found, install Node.js from https://nodejs.org/

**Check 2**: Use absolute path to npx
```bash
which npx
# Copy the full path (e.g., /usr/local/bin/npx)
```

Update configuration with absolute path:
```json
{
  "mcpServers": {
    "dossier": {
      "command": "/usr/local/bin/npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

---

### Issue: "command not found: dossier-mcp-server" (Option B users)

**Symptom**: Error says dossier-mcp-server command doesn't exist.

**Cause**: Package not installed globally or not in PATH.

**Solution**:

**Check 1**: Verify installation
```bash
npm list -g @ai-dossier/mcp-server
```

If not found:
```bash
npm install -g @ai-dossier/mcp-server
```

**Check 2**: Find installation location
```bash
which dossier-mcp-server
# Or
npm bin -g
```

Use absolute path in configuration if needed.

---

### Issue: First Run Slow (Option A users)

**Symptom**: First dossier command takes 10-30 seconds.

**Cause**: npx downloading package on first use.

**This is normal!** Subsequent runs will be instant (package is cached).

**To verify caching worked**:
Try the same command again - should be instant.

---

### Issue: Configuration File in Wrong Location

**Symptom**: Configuration doesn't seem to take effect.

**Solution**: Check Claude Code logs for actual configuration path:

1. Open Claude Code
2. Look for MCP server logs
3. Find the configuration file path being used
4. Update that file instead

Common alternate locations:
- `~/.config/claude/settings.json`
- `.claude/settings.local.json` (project-specific)
- `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

---

### Issue: Windows Path Problems

**Symptom**: Configuration works on Mac/Linux but not Windows.

**Solution**: Use forward slashes or double backslashes:

**Correct**:
```json
{
  "command": "C:/Users/username/AppData/Roaming/npm/npx.cmd"
}
```

**Or**:
```json
{
  "command": "C:\\Users\\username\\AppData\\Roaming\\npm\\npx.cmd"
}
```

**Incorrect**:
```json
{
  "command": "C:\Users\username\..."
}
```

---

### Still Having Issues?

1. **Check logs**: Claude Code console should show MCP server errors
2. **Test manually**: Try running MCP server directly:
   ```bash
   npx @ai-dossier/mcp-server
   # Or
   dossier-mcp-server
   # Or
   node /path/to/dossier/mcp-server/dist/index.js
   ```
3. **Verify network**: For npx, ensure you have internet access
4. **Get help**:
   - Issues: https://github.com/imboard-ai/ai-dossier/issues
   - Discussions: https://github.com/imboard-ai/ai-dossier/discussions

Include:
- Your OS and version
- Node.js/npm versions
- Configuration file contents
- Error messages from Claude Code logs

---

## Next Steps

### Now That MCP Server is Configured

You can:

1. **Execute any dossier** with automatic security verification:
   ```
   "Run examples/development/add-git-worktree-support.ds.md"
   ```

2. **Discover dossiers** in any project:
   ```
   "What dossiers are available in this project?"
   ```

3. **Verify dossier security** before execution:
   ```
   "Verify examples/devops/deploy-to-aws.ds.md"
   ```

4. **Access protocol documentation** anytime:
   ```
   "Read dossier://protocol"
   ```

5. **Learn about security model**:
   ```
   "Read dossier://security"
   ```

### Recommended Next Dossiers

Based on your setup being complete:

- **Beginner**: `examples/development/setup-react-library.ds.md` (medium risk, clear workflow)
- **Intermediate**: `examples/devops/deploy-to-aws.ds.md` (high risk, demonstrates approvals)
- **Advanced**: `examples/database/migrate-schema.ds.md` (critical risk, full security flow)

### Share Your Feedback

Help improve the dossier project:
- ⭐ Star the repository: https://github.com/imboard-ai/ai-dossier
- 💬 Share your experience in Discussions
- 🐛 Report issues or suggest improvements

---

## Examples

### Example 1: npx Configuration (Most Common)

**File**: `~/.claude/settings.local.json`
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

### Example 2: Global Install Configuration

**First, install**:
```bash
npm install -g @ai-dossier/mcp-server
```

**File**: `~/.claude/settings.local.json`
```json
{
  "mcpServers": {
    "dossier": {
      "command": "dossier-mcp-server"
    }
  }
}
```

### Example 3: Multiple MCP Servers

**File**: `~/.claude/settings.local.json`
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/files"]
    },
    "git": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"]
    }
  }
}
```

### Example 4: Debug Mode (Verbose Logging)

**File**: `~/.claude/settings.local.json`
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

Then check stderr logs for detailed MCP server activity.

---

## Notes

- This setup is **one-time per system** (or per project if using project-level config)
- MCP server runs automatically when Claude Code starts
- No separate server process or daemon needed
- Configuration can be updated anytime (restart Claude Code to apply)
- Multiple MCP servers can coexist (dossier + others)

---

**Setup Complete!** 🎉

You're now ready to use dossiers with full MCP server capabilities.
