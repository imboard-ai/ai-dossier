# Your First Dossier

Create, verify, and execute your first dossier in under 10 minutes.

## Prerequisites

- Node.js 20+ installed
- An AI assistant (Claude Code, Cursor, ChatGPT, or any LLM)
- A project directory to work in

## Step 1: Install the CLI

```bash
npm install -g @ai-dossier/cli
```

Verify it's installed:

```bash
ai-dossier --help
```

## Step 2: Create a Dossier

Create a file called `hello.ds.md` in your project:

```bash
ai-dossier create hello.ds.md
```

Or create it manually with this content:

```markdown
---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Hello World",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "stable",
  "objective": "Create a hello.txt file and verify it exists",
  "risk_level": "low",
  "risk_factors": ["creates_files"],
  "destructive_operations": []
}
---

# Hello World

## Objective

Create a file called `hello.txt` with a greeting message.

## Prerequisites

- Write access to the current directory

## Actions

1. Create a file called `hello.txt` in the current directory
2. Write the text "Hello from Dossier!" into it

## Validation

- [ ] File `hello.txt` exists in the current directory
- [ ] File contains the text "Hello from Dossier!"
```

## Step 3: Validate Your Dossier

Check that the dossier format is correct:

```bash
ai-dossier validate hello.ds.md
```

You should see output like:

```
📋 Dossier Validation

   File: hello.ds.md
   Title: Hello World
   Version: 1.0.0

✅ Valid
```

## Step 4: Add a Checksum

Checksums verify that the dossier content hasn't been tampered with:

```bash
ai-dossier checksum hello.ds.md --update
```

This adds a `checksum` field to the frontmatter. You can verify it later:

```bash
ai-dossier checksum hello.ds.md --verify
```

## Step 5: View Dossier Info

```bash
ai-dossier info hello.ds.md
```

This shows the metadata summary: title, version, risk level, checksum status, etc.

## Step 6: Execute with Your AI

Now give the dossier to your AI assistant.

**With Claude Code:**

```
Run the dossier at hello.ds.md
```

**With any LLM (copy-paste):**

Copy the entire content of `hello.ds.md` and paste it into your LLM chat with:

```
This is a dossier — a structured workflow for AI agents. Please execute it step-by-step and validate the success criteria.
```

**Expected result:** The AI creates `hello.txt` containing "Hello from Dossier!" and confirms the validation checks pass.

## Step 7: Verify the Result

Check that the AI did its job:

```bash
cat hello.txt
# Should output: Hello from Dossier!
```

## What You Learned

- Dossier files use the `.ds.md` extension
- The `---dossier` frontmatter contains structured JSON metadata
- The markdown body contains human-readable instructions for AI agents
- The CLI can validate, checksum, and inspect dossiers
- Any LLM can execute a dossier — no vendor lock-in

## Next Steps

- Browse [example dossiers](../../examples/) for real-world patterns
- Read the [Dossier Guide](../guides/dossier-guide.md) for schema details and best practices
- Try running a [git project review](../../examples/git-project-review/) dossier on your own project
- Learn about [security and signatures](../../security/ARCHITECTURE.md)
