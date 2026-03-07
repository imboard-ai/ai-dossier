# Git Project Review - Dossier Examples

LLM-powered analysis tools for understanding and improving your Git projects.

## What This Demonstrates

These dossiers showcase:
- ✅ **Real LLM value** - Analysis that can't be done without deep code understanding
- ✅ **Atomic & composable** - Small, focused dossiers that can be combined
- ✅ **Dogfooding** - Used on Dossier itself to improve the project
- ✅ **Reusable** - Run on any Git project to get insights

---

## How to Run These Dossiers

### Current: Ask Your LLM (Works Today) ⭐

You're already using an LLM assistant (Claude Code, Cursor, ChatGPT, etc.). Just ask it to execute the dossier!

#### On Your Local Project:
```
Analyze my project using the readme-reality-check dossier from:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md
```

#### On Any GitHub Project:
```
Analyze https://github.com/imboard-ai/mi6 using the onboarding-friction dossier from:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/onboarding-friction.ds.md
```

#### With Variables:
```
Analyze this codebase using the schema-capability-check dossier from:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/schema-capability-check.ds.md

Use this variable:
- capability: "Does the schema support referencing other dossier files?"
```

Your LLM will:
1. Fetch the dossier
2. Read the instructions
3. Analyze your project
4. Provide structured output

---

### Future Vision: CLI Tool (Aspirational)

The ideal UX would be:

```bash
# From registry
dossier run registry.dossier.ai/coding/readme-reality-check \
  --project https://github.com/imboard-ai/mi6

# Local dossier, remote project
dossier run ./atomic/readme-reality-check.ds.md \
  --project https://github.com/yourorg/yourproject

# Local dossier, local project
dossier run ./atomic/onboarding-friction.ds.md \
  --project .

# With variables
dossier run ./atomic/schema-capability-check.ds.md \
  --var capability="composition support"
```

**Status**: CLI tool not yet implemented. Contributions welcome!

---

## Quick Examples

### 1. Check README Accuracy (~30-60s)

**What it does**: Compares README claims vs actual implementation

**Run it**:
```
Hey Claude, analyze this project using:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md
```

**Output**: Promises kept ✅, promises broken ❌, undocumented features 🎁

---

### 2. Find Onboarding Friction (~45-90s)

**What it does**: Identifies pain points for new contributors

**Run it**:
```
Analyze https://github.com/yourproject using the onboarding-friction dossier:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/onboarding-friction.ds.md
```

**Output**: Friction score, blockers, confusion points, quick wins

---

### 3. Check Architecture Consistency (~60-90s)

**What it does**: Finds inconsistent patterns and duplication

**Run it**:
```
Use the architecture-patterns dossier on my project:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/architecture-patterns.ds.md
```

**Output**: Pattern inventory, inconsistencies, duplication hotspots

---

### 4. Meta: Explore Capabilities (~1-2min)

**What it does**: Answers "does the codebase support X?"

**Run it**:
```
Use this dossier to check if the schema supports composition:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/schema-capability-check.ds.md

Variable: "Does the schema support referencing other dossier files?"
```

**Output**: Yes/No/Partial answer with code evidence

## Available Atomic Dossiers

| Dossier | Duration | What It Analyzes | Value |
|---------|----------|------------------|-------|
| **schema-capability-check** | ~1-2 min | Explores codebase to answer: "Does it support X?" | Meta-tool for understanding capabilities |
| **readme-reality-check** | ~30-60s | README promises vs. actual code | Catches outdated docs, finds hidden features |
| **onboarding-friction** | ~45-90s | New contributor pain points | Identifies blockers and confusion |
| **architecture-patterns** | ~60-90s | Pattern consistency and duplication | Spots architectural drift |

## Use Cases

### For Maintainers
- Get a fresh perspective on your project
- Identify documentation drift
- Find quick wins to improve contributor experience
- Spot technical debt patterns

### For Contributors
- Understand a new project faster
- Find real vs. documented state
- Identify confusing areas before diving in

### For Security/Audit
- Find common vulnerability patterns
- Check input validation

---

## Tips for Running

### Scope Your Analysis
For large repos, you can focus on specific areas:
```
Analyze only the /src directory using the architecture-patterns dossier,
with focus on error handling patterns
```

### Combine Multiple Analyses
Run several dossiers in sequence:
```
Run these 3 dossiers on my project:
1. readme-reality-check
2. onboarding-friction
3. architecture-patterns

URLs: [paste all 3 GitHub raw URLs]
```

### Variable Usage
Many dossiers accept variables for customization:
- `project_path`: Focus on specific directory
- `focus_area`: Narrow the analysis scope
- `capability`: For schema-capability-check queries

---

## Composition (Future)

Once the schema supports dossier composition, we'll add:
```
composed/
├── quick-health.dossier      # 2-3 fast checks (~2min)
├── comprehensive.dossier     # All atomics (~5-10min)
└── custom-audit.dossier      # Interactive selection
```

These will reference the atomic dossiers and run them as a coordinated suite.

## Output Format

All dossiers output structured markdown with:
- Clear sections
- File:line references for evidence
- Actionable recommendations
- Severity/priority indicators

## Dogfooding

These dossiers are actively used on the Dossier project itself! Try running them:

```
Analyze the Dossier project itself using:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md

Target: https://github.com/imboard-ai/ai-dossier
```

**Meta insight**: Using a dossier to analyze the dossier project = perfect dogfooding! 🐕

## Contributing

Want to add more atomic dossiers? Great patterns to add:
- `test-coverage-gaps.ds.md` - Semantic coverage analysis
- `security-scan.ds.md` - Common vulnerability patterns
- `dependency-health.ds.md` - Outdated deps with impact analysis
- `tech-debt-hotspots.ds.md` - Files/areas needing refactor

Keep them:
- **Atomic** - One clear purpose
- **Fast** - Under 2 minutes
- **Actionable** - Specific recommendations with file:line references
- **Evidence-based** - Show proof from code, not speculation

## Learn More

- [Dossier Schema Documentation](../../SCHEMA.md)
- [Writing Custom Dossiers](../../docs/writing-dossiers.md)
- [Dossier Project Repository](https://github.com/imboard-ai/ai-dossier)
