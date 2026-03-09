# Record a Demo

Create a terminal recording that shows a dossier being executed. Useful for documentation, README demos, and sharing workflows with your team.

## Prerequisites

- A working dossier you want to demo (see [Author and Publish](./author-and-publish.md))
- [asciinema](https://asciinema.org/) installed:

  ```bash
  # macOS
  brew install asciinema

  # Ubuntu/Debian
  sudo apt install asciinema

  # pip (any platform)
  pip install asciinema
  ```

## Step 1: Plan the Recording

Decide what to show. A good demo recording covers:

1. **Verify** -- show the security check passing
2. **Execute** -- run the dossier with an AI
3. **Validate** -- show the success criteria being met

Keep it short. Under 2 minutes is ideal; anything over 3 minutes loses the viewer.

## Step 2: Prepare the Environment

Set up a clean state so the recording is reproducible:

```bash
# Create a temporary project directory
mkdir /tmp/demo-project && cd /tmp/demo-project
git init
```

If your dossier expects specific project structure (e.g., a `package.json`), create the minimum required files.

## Step 3: Record

```bash
asciinema rec demo.cast
```

Now run through your planned steps inside the recording session. For example:

```bash
# Show the dossier content
cat my-dossier.ds.md

# Verify integrity
ai-dossier verify my-dossier.ds.md

# Execute with Claude Code (or show the copy-paste flow for web LLMs)
# ...

# Show the result
ai-dossier info my-dossier.ds.md
```

When finished, press `Ctrl+D` or type `exit` to stop recording.

## Step 4: Review and Trim

Play back the recording:

```bash
asciinema play demo.cast
```

If you need to re-record, just run `asciinema rec demo.cast` again -- it overwrites the file.

## Step 5: Share

**Upload to asciinema.org:**

```bash
asciinema upload demo.cast
```

This returns a URL you can embed in READMEs and documentation.

**Convert to GIF (for GitHub READMEs):**

```bash
# Install agg (asciinema gif generator)
cargo install --git https://github.com/asciinema/agg

# Convert
agg demo.cast demo.gif
```

**Embed in markdown:**

```markdown
[![Demo](https://asciinema.org/a/YOUR_ID.svg)](https://asciinema.org/a/YOUR_ID)
```

## Tips for Good Recordings

- **Add pauses** between commands so viewers can read the output. Type deliberately, not fast.
- **Use a clean terminal** -- no distracting prompt customizations. Consider `export PS1='$ '` before recording.
- **Set terminal size** before recording: `stty rows 24 cols 80` gives a standard size that embeds well.
- **Show the result**, not just the process. End the recording with proof that the dossier achieved its objective.

## Next Steps

- Embed the recording in your dossier's README or the project documentation
- See the [examples/](../../examples/) directory for dossiers you can record demos of
