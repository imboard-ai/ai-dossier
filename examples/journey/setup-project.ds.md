---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "setup-project",
  "title": "Setup Project",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Initialize a new project directory with basic structure",
  "category": [
    "development"
  ],
  "tags": [
    "setup",
    "project",
    "example",
    "journey"
  ],
  "risk_level": "low",
  "risk_factors": [
    "modifies_files"
  ],
  "requires_approval": false,
  "outputs": {
    "configuration": [
      {
        "name": "project_path",
        "description": "Absolute path to the created project directory",
        "consumed_by": [
          "install-deps"
        ]
      }
    ]
  },
  "checksum": {
    "algorithm": "sha256",
    "hash": "65b4498bae9b227841796a1c72108215d08acc3970c3e2e9c7830d175bbabbf7"
  }
}
---

# Setup Project

## Objective

Initialize a new project directory with a basic file structure.

## Steps

1. Create a project directory under `/tmp/`:
   ```bash
   PROJECT_PATH="/tmp/example-project-$(date +%s)"
   mkdir -p "$PROJECT_PATH"
   ```

2. Create a basic `package.json`:
   ```bash
   cat > "$PROJECT_PATH/package.json" <<'EOF'
   {
     "name": "example-project",
     "version": "1.0.0",
     "description": "Example project for journey testing"
   }
   EOF
   ```

3. Note the project path — it will be passed to the next step as `project_path`.

## Output

- `project_path`: the absolute path to the created directory (e.g., `/tmp/example-project-1234567890`)
