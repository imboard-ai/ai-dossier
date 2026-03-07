---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Setup React Component Library",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "last_updated": "2025-11-05",
  "objective": "Create a production-ready React component library with TypeScript, Storybook, testing, and NPM publishing configuration",
  "category": [
    "development",
    "setup"
  ],
  "tags": [
    "react",
    "typescript",
    "component-library",
    "storybook",
    "vite",
    "npm",
    "testing"
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "62897b1b4f8b066a009707d834732035cfd2ce994346239e50d7ada7d0f3fde3"
  },
  "risk_level": "medium",
  "risk_factors": [
    "modifies_files",
    "executes_external_code",
    "network_access"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates new files and directories in current directory",
    "Installs NPM dependencies (~300MB in node_modules)",
    "Initializes git repository (if not already initialized)",
    "Downloads and executes package installation scripts"
  ],
  "estimated_duration": {
    "min_minutes": 10,
    "max_minutes": 30
  },
  "coupling": {
    "level": "Loose",
    "details": "Creates self-contained library project. No dependencies on external systems except NPM registry for package installation."
  },
  "mcp_integration": {
    "required": false,
    "server_name": "@ai-dossier/mcp-server",
    "min_version": "1.0.0",
    "features_used": [
      "verify_dossier"
    ],
    "fallback": "manual_execution",
    "benefits": [
      "Automatic checksum verification",
      "Streamlined setup validation"
    ]
  },
  "signature": {
    "algorithm": "ECDSA-SHA-256",
    "signature": "MEUCIQDx/1g0CgiXen+dV8DsFCMjEn7U9/XvwCQRIFEh7/DJDwIgPTu9EGkLx8FqflmgfS3b3MJvDBvbhuQFXvZC31dd7HI=",
    "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqIbQGqW1Jdh97TxQ5ZvnSVvvOcN5NWhfWwXRAaDDuKK1pv8F+kz+uo1W8bNn+8ObgdOBecFTFizkRa/g+QJ8kA==",
    "key_id": "arn:aws:kms:us-east-1:942039714848:key/d9ccd3fc-b190-49fd-83f7-e94df6620c1d",
    "signed_at": "2025-11-16T11:23:31.933Z",
    "signed_by": "Dossier Team <team@dossier.ai>"
  }
}
---
# Dossier: Setup React Component Library

**Protocol Version**: 1.0 ([PROTOCOL.md](../../PROTOCOL.md))

**Purpose**: Create a production-ready React component library with TypeScript, Storybook, testing, and NPM publishing configuration.

**When to use**: When you need to build a reusable component library for sharing components across projects or publishing to NPM for public/private use.

---

*Before executing, optionally review [PROTOCOL.md](../../PROTOCOL.md) for self-improvement protocol and execution guidelines.*

---

## 📋 Metadata

### Version
- **Dossier**: v1.0.0
- **Protocol**: v1.0
- **Last Updated**: 2025-11-05

### Relationships

**Preceded by**:
- None (self-contained)

**Followed by**:
- publish-npm-package.md - Publish library to NPM registry (suggested)
- setup-ci-cd.md - Automate builds and releases (suggested)

**Alternatives**:
- setup-vue-library.md - For Vue.js component libraries
- setup-web-components.md - For framework-agnostic web components

**Conflicts with**:
- None

**Can run in parallel with**:
- None (requires focused setup)

### Outputs

**Files created**:
- `package.json` - NPM package configuration (required)
- `tsconfig.json` - TypeScript configuration (required)
- `vite.config.ts` - Vite bundler configuration (required)
- `.storybook/main.ts` - Storybook configuration (required)
- `.storybook/preview.ts` - Storybook preview config (required)
- `vitest.config.ts` - Testing configuration (required)
- `src/index.ts` - Library entry point (required)
- `src/components/Button/` - Example component with tests and stories (required)
- `dist/` - Built library output (generated)
- `.npmignore` - NPM publish exclusions (required)

**Configuration produced**:
- TypeScript strict mode with React JSX support
- Vite library build with multiple output formats (ESM, CJS, UMD)
- Storybook with essential addons (a11y, docs, controls)
- Vitest with React Testing Library integration

**State changes**:
- NPM dependencies installed - Affects: node_modules size (~300MB)
- Git repository initialized - Affects: version control setup

### Inputs

**Required**:
- Library name (kebab-case for NPM)
- Library description
- Author information

**Optional**:
- License type (default: MIT)
- Repository URL (for published packages)
- CSS solution (styled-components, CSS modules, Tailwind)
- Component structure (flat vs categorized)

### Coupling

**Level**: Loose
**Details**: Self-contained library setup with no external dossier dependencies. Published package can be consumed by any React application.

---

## Objective

Create a complete React component library with:
- **TypeScript**: Strict typing with generated .d.ts files
- **Vite**: Fast development and optimized builds
- **Storybook**: Interactive component documentation
- **Testing**: Vitest + React Testing Library
- **Publishing**: NPM-ready package.json configuration
- **Example components**: Starter components with tests and stories

Success means: A fully functional component library that can be developed locally, viewed in Storybook, tested, built, and published to NPM.

---

## Prerequisites

**Environment Requirements**:
- Node.js 20+ installed
- NPM 9+ or Yarn/PNPM
- Git installed
- Modern code editor (VSCode recommended)

**Knowledge Prerequisites**:
- Basic React knowledge
- Understanding of TypeScript (or willingness to learn)
- Familiarity with NPM packages

**Validation**:

```bash
# Check Node.js version (need 18+)
node --version

# Check NPM version
npm --version

# Check Git
git --version

# Check available disk space (need ~500MB for dependencies)
df -h . | tail -1
```

---

## Context to Gather

### 1. Detect Existing Project

```bash
# Check if already in a project
test -f package.json && echo "⚠️  package.json exists" || echo "✓ No existing package.json"

# Check for existing React installation
test -d node_modules/react && echo "React already installed" || echo "No React found"

# Check for existing TypeScript config
test -f tsconfig.json && echo "⚠️  tsconfig.json exists" || echo "✓ No TypeScript config"

# Check git status
git rev-parse --git-dir > /dev/null 2>&1 && echo "Git repo exists" || echo "Not a git repo"
```

### 2. Check Node.js Environment

```bash
# Node version
node --version

# Package manager
which npm && echo "NPM available"
which yarn && echo "Yarn available"
which pnpm && echo "PNPM available"

# Check global packages
npm list -g --depth=0 | grep -E "(typescript|vite)"
```

### 3. Determine Library Requirements

**Ask user or use defaults**:
- Library name: `my-component-library`
- Scope (for org packages): `@myorg/my-library`
- Description: Purpose of the library
- Components to include: Start with Button, Input, Card examples

**Output Format**:
```
Environment: Node 20.10.0, NPM 10.2.3
Project Status: Clean directory (no existing package.json)
Library Name: @acme/ui-components
Description: Reusable UI components for Acme products
Target: Internal use + NPM publish
CSS Strategy: CSS Modules
```

---

## Decision Points

### Decision 1: Bundler Selection

**Based on**: Build speed, output requirements, community support

**Options**:
- **Vite**: Modern, fast, great DX
  - Use when: Starting new library, want fast HMR, modern tooling
  - Pros: Extremely fast, simple config, built-in TypeScript support
  - Cons: Newer (less mature than Rollup alone)

- **Rollup**: Established, flexible
  - Use when: Need fine-grained control, complex plugin setup
  - Pros: Mature, highly configurable, tree-shaking
  - Cons: More configuration, slower DX

- **Webpack**: Full-featured, complex
  - Use when: Need advanced features, compatibility with old tools
  - Pros: Powerful, extensive ecosystem
  - Cons: Slow, complex configuration

**Recommendation**: Vite for modern DX and speed

### Decision 2: TypeScript Configuration

**Based on**: Type safety vs development speed

**Options**:
- **Strict Mode**: Maximum type safety
  - Use when: Production library, want robust types
  - Recommended for published libraries
  - Catches more bugs

- **Relaxed Mode**: Faster development
  - Use when: Prototype, internal use only
  - Allows `any` types, less strict checks

**Recommendation**: Strict mode for published libraries

### Decision 3: CSS Solution

**Based on**: Team preference, bundle size, DX

**Options**:
- **CSS Modules**: Scoped CSS, familiar
  - Use when: Want traditional CSS with scoping
  - Pros: No runtime, familiar syntax, type-safe
  - Cons: Separate files, no dynamic theming

- **Styled-Components**: CSS-in-JS
  - Use when: Need dynamic theming, prefer JS colocation
  - Pros: Dynamic, theming built-in, component-scoped
  - Cons: Runtime overhead, larger bundle

- **Tailwind CSS**: Utility-first
  - Use when: Rapid development, design system exists
  - Pros: Fast development, consistent design
  - Cons: Class name verbosity, learning curve

- **Vanilla Extract**: Zero-runtime CSS-in-TS
  - Use when: Want type-safe CSS with no runtime
  - Pros: Type-safe, no runtime, fast
  - Cons: Learning curve, newer

**Recommendation**: CSS Modules for simplicity and zero runtime cost

### Decision 4: Component Organization

**Based on**: Library size, discoverability

**Options**:
- **Flat Structure**: All components at same level
  ```
  src/
    Button/
    Input/
    Card/
  ```
  - Use when: <20 components
  - Simple, easy to find

- **Categorized Structure**: Grouped by purpose
  ```
  src/
    inputs/
      Button/
      Input/
    layout/
      Card/
      Grid/
  ```
  - Use when: >20 components
  - Better organization for large libraries

**Recommendation**: Flat for small libraries, categorized for 20+ components

---

## Actions to Perform

### Step 1: Initialize Project

**What to do**: Create project structure and git repository

**Commands**:
```bash
# Create project directory
mkdir my-component-library
cd my-component-library

# Initialize git
git init
echo "node_modules" > .gitignore
echo "dist" >> .gitignore
echo ".DS_Store" >> .gitignore
echo "*.log" >> .gitignore
echo "storybook-static" >> .gitignore

# Initial commit
git add .gitignore
git commit -m "Initial commit: project structure"
```

**Expected outcome**: Clean git repository initialized

**Validation**:
```bash
git status  # Should show "On branch main, nothing to commit"
test -f .gitignore && echo "✓ .gitignore created"
```

### Step 2: Create package.json

**What to do**: Initialize NPM package with library configuration

**Commands**:
```bash
npm init -y
```

**Then edit `package.json`**:

```json
{
  "name": "@myorg/ui-components",
  "version": "0.1.0",
  "description": "Reusable React UI components",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./styles.css": "./dist/style.css"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build",
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "typecheck": "tsc --noEmit"
  },
  "keywords": [
    "react",
    "components",
    "ui",
    "typescript"
  ],
  "author": "Your Name <your.email@example.com>",
  "license": "MIT",
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {},
  "dependencies": {}
}
```

**Expected outcome**: package.json configured for library publishing

**Validation**:
```bash
cat package.json | grep -E "(main|module|types)" && echo "✓ Entry points configured"
```

### Step 3: Install Core Dependencies

**What to do**: Install React, TypeScript, and build tools

**Commands**:
```bash
# Install React as peer dependencies (for development)
npm install --save-dev react react-dom @types/react @types/react-dom

# Install TypeScript
npm install --save-dev typescript

# Install Vite and plugins
npm install --save-dev vite @vitejs/plugin-react vite-plugin-dts

# Install path resolver
npm install --save-dev @types/node
```

**Expected outcome**: Core dependencies installed (~100MB node_modules)

**Validation**:
```bash
test -d node_modules && echo "✓ Dependencies installed"
npm list react typescript vite | head -10
```

### Step 4: Configure TypeScript

**What to do**: Setup strict TypeScript with React JSX support

**Create file**: `tsconfig.json`

```json
{
  "compilerOptions": {
    /* Language and Environment */
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",

    /* Modules */
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,

    /* Emit */
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "noEmit": true,

    /* Interop Constraints */
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true,

    /* Type Checking */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,

    /* Skip Lib Check */
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.tsx", "**/*.test.ts"]
}
```

**Expected outcome**: TypeScript configured with strict mode

**Validation**:
```bash
npx tsc --version
cat tsconfig.json | grep '"strict": true' && echo "✓ Strict mode enabled"
```

### Step 5: Configure Vite

**What to do**: Setup Vite for library build

**Create file**: `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src/**/*'],
      exclude: ['src/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.stories.tsx'],
      rollupTypes: true
    })
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MyComponentLibrary',
      formats: ['es', 'cjs'],
      fileName: (format) => {
        if (format === 'es') return 'index.js';
        if (format === 'cjs') return 'index.cjs';
        return `index.${format}.js`;
      }
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime'
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'style.css';
          return assetInfo.name || '';
        }
      }
    },
    sourcemap: true,
    emptyOutDir: true
  }
});
```

**Expected outcome**: Vite configured for library mode

**Validation**:
```bash
test -f vite.config.ts && echo "✓ Vite config created"
```

### Step 6: Install and Configure Storybook

**What to do**: Setup Storybook for component documentation

**Commands**:
```bash
# Install Storybook
npx storybook@latest init --type react_vite --yes

# Install essential addons
npm install --save-dev @storybook/addon-essentials @storybook/addon-a11y @storybook/addon-interactions @storybook/test
```

**Update `.storybook/main.ts`**:

```typescript
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
    '@storybook/addon-interactions'
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  docs: {
    autodocs: 'tag'
  },
  typescript: {
    check: true,
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      propFilter: (prop) =>
        prop.parent ? !/node_modules/.test(prop.parent.fileName) : true
    }
  }
};

export default config;
```

**Create `.storybook/preview.ts`**:

```typescript
import type { Preview } from '@storybook/react';
import '../src/styles/global.css'; // If you have global styles

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'dark', value: '#1a1a1a' }
      ]
    }
  }
};

export default preview;
```

**Expected outcome**: Storybook configured and ready

**Validation**:
```bash
test -d .storybook && echo "✓ Storybook configured"
npm run storybook --help > /dev/null && echo "✓ Storybook script ready"
```

### Step 7: Setup Testing

**What to do**: Configure Vitest with React Testing Library

**Commands**:
```bash
# Install testing dependencies
npm install --save-dev vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitest/ui
```

**Create file**: `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.stories.tsx',
        '**/*.test.tsx',
        'dist/'
      ]
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  }
});
```

**Create file**: `src/test/setup.ts`

```typescript
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Cleanup after each test
afterEach(() => {
  cleanup();
});
```

**Expected outcome**: Testing framework ready

**Validation**:
```bash
test -f vitest.config.ts && echo "✓ Vitest configured"
npm run test -- --version
```

### Step 8: Create Library Entry Point

**What to do**: Create main index file that exports all components

**Create directory structure**:
```bash
mkdir -p src/components
mkdir -p src/styles
mkdir -p src/types
```

**Create file**: `src/index.ts`

```typescript
// Export all components
export { Button } from './components/Button';
export type { ButtonProps } from './components/Button';

// Add more exports as you create components
// export { Input } from './components/Input';
// export { Card } from './components/Card';

// Export types
export * from './types';
```

**Create file**: `src/types/index.ts`

```typescript
// Common types for the library
export type Size = 'small' | 'medium' | 'large';
export type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface BaseComponentProps {
  className?: string;
  'data-testid'?: string;
}
```

**Expected outcome**: Entry point ready for exports

**Validation**:
```bash
test -f src/index.ts && echo "✓ Entry point created"
```

### Step 9: Create Example Button Component

**What to do**: Build complete example component with styles, tests, and stories

**Create directory**:
```bash
mkdir -p src/components/Button
```

**Create file**: `src/components/Button/Button.tsx`

```typescript
import React from 'react';
import styles from './Button.module.css';
import type { Size, Variant, BaseComponentProps } from '../../types';

export interface ButtonProps extends BaseComponentProps {
  /** Button text content */
  children: React.ReactNode;
  /** Button variant style */
  variant?: Variant;
  /** Button size */
  size?: Size;
  /** Disable button interaction */
  disabled?: boolean;
  /** Full width button */
  fullWidth?: boolean;
  /** Click handler */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Button type */
  type?: 'button' | 'submit' | 'reset';
}

/**
 * Primary UI component for user interaction
 */
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'medium',
  disabled = false,
  fullWidth = false,
  onClick,
  type = 'button',
  className = '',
  'data-testid': dataTestId = 'button'
}) => {
  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classNames}
      onClick={onClick}
      disabled={disabled}
      data-testid={dataTestId}
    >
      {children}
    </button>
  );
};

Button.displayName = 'Button';
```

**Create file**: `src/components/Button/Button.module.css`

```css
.button {
  font-family: system-ui, -apple-system, sans-serif;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  outline: none;
  position: relative;
}

.button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sizes */
.small {
  padding: 6px 12px;
  font-size: 14px;
  line-height: 20px;
}

.medium {
  padding: 10px 20px;
  font-size: 16px;
  line-height: 24px;
}

.large {
  padding: 14px 28px;
  font-size: 18px;
  line-height: 28px;
}

/* Variants */
.primary {
  background-color: #0070f3;
  color: white;
}

.primary:hover:not(:disabled) {
  background-color: #0060df;
}

.primary:active:not(:disabled) {
  background-color: #0050c5;
}

.secondary {
  background-color: #eaeaea;
  color: #333;
}

.secondary:hover:not(:disabled) {
  background-color: #d0d0d0;
}

.secondary:active:not(:disabled) {
  background-color: #b8b8b8;
}

.danger {
  background-color: #e00;
  color: white;
}

.danger:hover:not(:disabled) {
  background-color: #c00;
}

.danger:active:not(:disabled) {
  background-color: #a00;
}

.ghost {
  background-color: transparent;
  color: #0070f3;
  border: 1px solid #0070f3;
}

.ghost:hover:not(:disabled) {
  background-color: rgba(0, 112, 243, 0.1);
}

.ghost:active:not(:disabled) {
  background-color: rgba(0, 112, 243, 0.2);
}

/* Full width */
.fullWidth {
  width: 100%;
}
```

**Create file**: `src/components/Button/Button.test.tsx`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders with text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);

    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });

  it('does not call onClick when disabled', async () => {
    const handleClick = vi.fn();
    render(<Button disabled onClick={handleClick}>Disabled</Button>);

    const button = screen.getByRole('button');
    await userEvent.click(button);

    expect(handleClick).not.toHaveBeenCalled();
  });

  it('applies variant classes', () => {
    const { rerender } = render(<Button variant="primary">Primary</Button>);
    expect(screen.getByRole('button')).toHaveClass('primary');

    rerender(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole('button')).toHaveClass('secondary');

    rerender(<Button variant="danger">Danger</Button>);
    expect(screen.getByRole('button')).toHaveClass('danger');
  });

  it('applies size classes', () => {
    const { rerender } = render(<Button size="small">Small</Button>);
    expect(screen.getByRole('button')).toHaveClass('small');

    rerender(<Button size="medium">Medium</Button>);
    expect(screen.getByRole('button')).toHaveClass('medium');

    rerender(<Button size="large">Large</Button>);
    expect(screen.getByRole('button')).toHaveClass('large');
  });

  it('applies fullWidth class', () => {
    render(<Button fullWidth>Full Width</Button>);
    expect(screen.getByRole('button')).toHaveClass('fullWidth');
  });

  it('accepts custom className', () => {
    render(<Button className="custom-class">Custom</Button>);
    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('accepts custom data-testid', () => {
    render(<Button data-testid="custom-button">Custom</Button>);
    expect(screen.getByTestId('custom-button')).toBeInTheDocument();
  });

  it('has correct button type', () => {
    const { rerender } = render(<Button type="button">Button</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');

    rerender(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');

    rerender(<Button type="reset">Reset</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'reset');
  });
});
```

**Create file**: `src/components/Button/Button.stories.tsx`

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { Button } from './Button';

const meta = {
  title: 'Components/Button',
  component: Button,
  parameters: {
    layout: 'centered'
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'danger', 'ghost']
    },
    size: {
      control: 'select',
      options: ['small', 'medium', 'large']
    },
    disabled: {
      control: 'boolean'
    },
    fullWidth: {
      control: 'boolean'
    }
  },
  args: {
    onClick: fn()
  }
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: {
    variant: 'primary',
    children: 'Primary Button'
  }
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Secondary Button'
  }
};

export const Danger: Story = {
  args: {
    variant: 'danger',
    children: 'Danger Button'
  }
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    children: 'Ghost Button'
  }
};

export const Small: Story = {
  args: {
    size: 'small',
    children: 'Small Button'
  }
};

export const Medium: Story = {
  args: {
    size: 'medium',
    children: 'Medium Button'
  }
};

export const Large: Story = {
  args: {
    size: 'large',
    children: 'Large Button'
  }
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: 'Disabled Button'
  }
};

export const FullWidth: Story = {
  args: {
    fullWidth: true,
    children: 'Full Width Button'
  },
  parameters: {
    layout: 'padded'
  }
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="ghost">Ghost</Button>
    </div>
  ),
  parameters: {
    layout: 'centered'
  }
};

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
      <Button size="small">Small</Button>
      <Button size="medium">Medium</Button>
      <Button size="large">Large</Button>
    </div>
  ),
  parameters: {
    layout: 'centered'
  }
};
```

**Create file**: `src/components/Button/index.ts`

```typescript
export { Button } from './Button';
export type { ButtonProps } from './Button';
```

**Expected outcome**: Complete Button component with tests and stories

**Validation**:
```bash
test -f src/components/Button/Button.tsx && echo "✓ Button component created"
test -f src/components/Button/Button.test.tsx && echo "✓ Tests created"
test -f src/components/Button/Button.stories.tsx && echo "✓ Stories created"
```

### Step 10: Build and Test

**What to do**: Verify everything works

**Commands**:
```bash
# Run TypeScript type checking
npm run typecheck

# Run tests
npm run test

# Build the library
npm run build

# Check build output
ls -lh dist/
cat dist/index.d.ts | head -20

# Start Storybook (optional, opens in browser)
# npm run storybook
```

**Expected outcome**:
- TypeScript compiles without errors
- All tests pass
- Build produces `dist/` with `.js`, `.cjs`, `.d.ts` files
- Storybook runs successfully

**Validation**:
```bash
# Check build artifacts exist
test -f dist/index.js && echo "✓ ESM build"
test -f dist/index.cjs && echo "✓ CJS build"
test -f dist/index.d.ts && echo "✓ Type definitions"

# Verify exports in type definitions
grep "export.*Button" dist/index.d.ts && echo "✓ Button exported"
```

### Step 11: Create NPM Ignore File

**What to do**: Specify files to exclude from NPM package

**Create file**: `.npmignore`

```
# Source files
src/
.storybook/

# Config files
*.config.ts
tsconfig.json
vitest.config.ts
vite.config.ts

# Development
node_modules/
.git/
.gitignore

# Build artifacts (keep dist/)
storybook-static/

# Tests
**/*.test.tsx
**/*.test.ts
**/*.spec.tsx
**/*.spec.ts
coverage/

# Stories
**/*.stories.tsx
**/*.stories.ts

# Misc
.DS_Store
*.log
.env
.env.local
```

**Expected outcome**: NPM package will only include dist/ and package.json

**Validation**:
```bash
# Simulate package contents
npx npm-packlist | head -20
```

### Step 12: Add README and Documentation

**What to do**: Create comprehensive README for NPM

**Create file**: `README.md`

````markdown
# @myorg/ui-components

> Reusable React UI components built with TypeScript

## Installation

```bash
npm install @myorg/ui-components
```

## Usage

```tsx
import { Button } from '@myorg/ui-components';
import '@myorg/ui-components/dist/style.css';

function App() {
  return (
    <Button variant="primary" onClick={() => alert('Clicked!')}>
      Click me
    </Button>
  );
}
```

## Components

### Button

A versatile button component with multiple variants and sizes.

```tsx
<Button variant="primary" size="medium" onClick={handleClick}>
  Primary Button
</Button>
```

**Props:**

- `variant`: `'primary' | 'secondary' | 'danger' | 'ghost'` - Button style variant
- `size`: `'small' | 'medium' | 'large'` - Button size
- `disabled`: `boolean` - Disable button interaction
- `fullWidth`: `boolean` - Make button full width
- `onClick`: `(event: MouseEvent) => void` - Click handler
- `type`: `'button' | 'submit' | 'reset'` - Button type

## Development

```bash
# Install dependencies
npm install

# Run Storybook
npm run storybook

# Run tests
npm run test

# Build library
npm run build
```

## License

MIT © Your Name
````

**Expected outcome**: Complete documentation for users

---

## Validation

### Success Criteria

1. ✅ Project initialized with git
2. ✅ package.json configured for library publishing
3. ✅ TypeScript strict mode enabled
4. ✅ Vite builds library in multiple formats (ESM, CJS)
5. ✅ Storybook runs and displays components
6. ✅ Tests pass with Vitest
7. ✅ Example Button component works in all variants
8. ✅ Type definitions generated (.d.ts)
9. ✅ Build output is clean and minimal
10. ✅ Ready for NPM publishing

### Validation Commands

```bash
# 1. Type checking passes
npm run typecheck && echo "✓ TypeScript OK"

# 2. Tests pass
npm run test run && echo "✓ Tests OK"

# 3. Build succeeds
npm run build && echo "✓ Build OK"

# 4. Check package contents
npx npm-packlist

# 5. Test local installation
npm pack
# Creates tarball you can test install: npm install ./myorg-ui-components-0.1.0.tgz

# 6. Verify exports
node -e "console.log(require('./dist/index.cjs'))" && echo "✓ CJS works"
node --input-type=module -e "import('./dist/index.js').then(console.log)" && echo "✓ ESM works"
```

### If Validation Fails

**Problem**: TypeScript errors in build

**Solution**:
```bash
# Check for type errors
npm run typecheck

# Common fixes:
# 1. Missing type definitions
npm install --save-dev @types/node

# 2. Module resolution issues - check tsconfig.json
# 3. Import paths - use relative paths or path aliases
```

**Problem**: Tests fail

**Solution**:
```bash
# Run tests with UI for debugging
npm run test:ui

# Check test setup file
cat src/test/setup.ts

# Ensure @testing-library/jest-dom is imported
```

**Problem**: Storybook won't start

**Solution**:
```bash
# Clear cache
rm -rf node_modules/.cache

# Reinstall Storybook
npm install --save-dev @storybook/react-vite@latest

# Check .storybook/main.ts for errors
```

---

## Example

### Before:
```
./
```

### After:
```
my-component-library/
├── .storybook/
│   ├── main.ts                    # Storybook config
│   └── preview.ts                 # Storybook preview
├── src/
│   ├── components/
│   │   └── Button/
│   │       ├── Button.tsx         # Component
│   │       ├── Button.module.css  # Styles
│   │       ├── Button.test.tsx    # Tests
│   │       ├── Button.stories.tsx # Storybook stories
│   │       └── index.ts           # Exports
│   ├── types/
│   │   └── index.ts               # Shared types
│   ├── test/
│   │   └── setup.ts               # Test setup
│   └── index.ts                   # Library entry
├── dist/                          # Build output
│   ├── index.js                   # ESM build
│   ├── index.cjs                  # CommonJS build
│   ├── index.d.ts                 # Type definitions
│   └── style.css                  # Bundled styles
├── node_modules/                  # Dependencies
├── .gitignore
├── .npmignore
├── package.json                   # NPM config
├── tsconfig.json                  # TypeScript config
├── vite.config.ts                 # Vite config
├── vitest.config.ts               # Vitest config
└── README.md                      # Documentation
```

### Build Output (`dist/index.d.ts`):

```typescript
import * as react from 'react';

type Size = 'small' | 'medium' | 'large';
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface BaseComponentProps {
    className?: string;
    'data-testid'?: string;
}

interface ButtonProps extends BaseComponentProps {
    children: react.ReactNode;
    variant?: Variant;
    size?: Size;
    disabled?: boolean;
    fullWidth?: boolean;
    onClick?: (event: react.MouseEvent<HTMLButtonElement>) => void;
    type?: 'button' | 'submit' | 'reset';
}

declare const Button: react.FC<ButtonProps>;

export { Button, type ButtonProps, type Size, type Variant };
```

### Using the Library:

```tsx
// In a consuming application
import { Button } from '@myorg/ui-components';
import '@myorg/ui-components/dist/style.css';

function MyApp() {
  return (
    <div>
      <Button variant="primary">Click me</Button>
      <Button variant="secondary" size="large">Large Button</Button>
      <Button variant="danger" disabled>Disabled</Button>
    </div>
  );
}
```

### Package.json Scripts:

```bash
# Development
npm run dev              # Start Vite dev server
npm run storybook        # Open Storybook

# Testing
npm run test             # Run tests in watch mode
npm run test:ui          # Run tests with UI
npm run test:coverage    # Generate coverage report

# Build
npm run build            # Build library for production
npm run typecheck        # Check TypeScript types

# Storybook
npm run build-storybook  # Build static Storybook
```

---

## Troubleshooting

### Issue 1: Module Resolution Errors

**Symptoms**:
- `Cannot find module 'react'`
- Import errors in TypeScript

**Causes**:
- Incorrect tsconfig.json settings
- Missing dependencies
- Wrong module format

**Solutions**:

1. Verify React is in peerDependencies AND devDependencies:
```json
{
  "peerDependencies": {
    "react": "^18.0.0"
  },
  "devDependencies": {
    "react": "^18.2.0"
  }
}
```

2. Check tsconfig.json moduleResolution:
```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"
  }
}
```

3. Clear cache and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Issue 2: CSS Modules Not Working

**Symptoms**:
- Styles not applied
- `styles.button is undefined`

**Causes**:
- Missing CSS module type definitions
- Incorrect import path

**Solutions**:

1. Create type definition for CSS modules:
```typescript
// src/types/css-modules.d.ts
declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}
```

2. Verify import uses `.module.css`:
```typescript
import styles from './Button.module.css'; // Correct
import styles from './Button.css';        // Wrong
```

3. Check vite.config.ts includes CSS:
```typescript
{
  css: {
    modules: {
      localsConvention: 'camelCase'
    }
  }
}
```

### Issue 3: Storybook Stories Not Detected

**Symptoms**:
- Empty Storybook
- "No stories found"

**Causes**:
- Wrong story file pattern
- Incorrect .storybook/main.ts config

**Solutions**:

1. Check stories pattern in .storybook/main.ts:
```typescript
stories: [
  '../src/**/*.stories.@(js|jsx|ts|tsx)',  // Match .stories.tsx
  '../src/**/*.mdx'
]
```

2. Verify story file naming:
```
Button.stories.tsx  ✓ Correct
Button.story.tsx    ✗ Won't match
```

3. Check story export:
```typescript
// Must have default export
export default {
  title: 'Components/Button',
  component: Button
} satisfies Meta<typeof Button>;
```

### Issue 4: Build Fails with Type Errors

**Symptoms**:
- `tsc` errors during build
- Type definition generation fails

**Causes**:
- Strict mode catching errors
- Missing type imports
- Test files included in build

**Solutions**:

1. Exclude test files in tsconfig.json:
```json
{
  "exclude": [
    "node_modules",
    "dist",
    "**/*.test.tsx",
    "**/*.test.ts",
    "**/*.stories.tsx"
  ]
}
```

2. Fix strict mode errors:
```typescript
// Add explicit types
const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  // ...
};

// Use non-null assertion only when safe
const element = document.querySelector('.button')!;
```

3. Use vite-plugin-dts exclude:
```typescript
dts({
  exclude: ['src/**/*.test.tsx', 'src/**/*.stories.tsx']
})
```

### Issue 5: Package Too Large

**Symptoms**:
- NPM package > 10MB
- Slow install times

**Causes**:
- Source files included
- node_modules in package
- Large assets bundled

**Solutions**:

1. Check .npmignore:
```
src/
node_modules/
.storybook/
**/*.test.tsx
```

2. Verify package contents:
```bash
npx npm-packlist
# Should only show dist/, package.json, README.md
```

3. Check bundle size:
```bash
npm run build
du -sh dist/
# Should be <1MB for small libraries
```

4. Analyze bundle:
```bash
npm install --save-dev rollup-plugin-visualizer
# Add to vite.config.ts
```

---

## Notes for LLM Execution

### Critical Steps

1. **Always install dependencies** before building or testing
2. **Create test setup file** before running tests
3. **Configure TypeScript strictly** for better DX
4. **Use CSS Modules** for scoped styling without runtime cost
5. **Export types** alongside components for TypeScript users

### User Customization Points

Ask user for:
- Library name (validate it's available on NPM)
- Scoped package? (@org/name vs name)
- License type (MIT, Apache-2.0, etc.)
- Initial components to create
- CSS strategy preference

### Quality Checks

Before completing:
- [ ] All tests pass
- [ ] TypeScript builds without errors
- [ ] Storybook displays all components
- [ ] Package.json has correct entry points
- [ ] README has usage examples
- [ ] .npmignore excludes source files

### Publishing Guidance

When user wants to publish:
```bash
# 1. Test package locally
npm pack
npm install ./myorg-ui-components-0.1.0.tgz

# 2. Login to NPM
npm login

# 3. Publish (dry-run first)
npm publish --dry-run

# 4. Actually publish
npm publish --access public  # For scoped packages
```

---

## Related Dossiers

- **publish-npm-package.md** - Publish to NPM registry
- **setup-component-docs.md** - Enhanced documentation with Docusaurus
- **setup-monorepo.md** - Manage multiple packages
- **add-eslint-prettier.md** - Code quality tools

---

## Version History

- **v1.0.0** (2025-11-05) - Initial version with Vite, Storybook, Vitest

---

## Self-Improvement Notes

*This section follows the Dossier Protocol for self-improvement. LLMs executing this dossier should note any issues, improvements, or adaptations here.*

**Template for improvements**:
```markdown
### Improvement: [Title]
- **Date**: YYYY-MM-DD
- **Issue**: [What didn't work or could be better]
- **Solution**: [How it was improved]
- **Impact**: [What this enables or fixes]
```

---

**End of Dossier**

*Remember: A great component library has excellent TypeScript support, comprehensive tests, and interactive documentation. Don't skip any of these!*
