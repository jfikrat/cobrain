# Contributing

Thank you for your interest in contributing to Cobrain! This guide will help you get started.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.3.5 or higher
- [Git](https://git-scm.com)
- A Telegram account (for testing)
- Anthropic API key (for AI features)

### Development Setup

1. **Fork and clone the repository**

   ```bash
   git clone https://github.com/yourusername/cobrain.git
   cd cobrain
   ```

2. **Install dependencies**

   ```bash
   bun install
   ```

3. **Set up environment**

   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Start development server**

   ```bash
   # Terminal 1: CSS watch
   bun run dev:css

   # Terminal 2: Server with HMR
   bun run dev
   ```

## Code Style

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Prefer explicit types over `any`
- Use interfaces for object shapes

```typescript
// Good
interface User {
  id: number;
  name: string;
}

function getUser(id: number): User {
  // ...
}

// Avoid
function getUser(id: any): any {
  // ...
}
```

### Formatting

- Use 2 spaces for indentation
- Use single quotes for strings
- No trailing commas
- Semicolons required

The project uses EditorConfig for consistent formatting.

### File Organization

```
src/
├── index.ts           # Entry point only
├── config.ts          # Configuration
├── types/             # Type definitions
├── services/          # Business logic
├── channels/          # Communication (Telegram, etc.)
├── agent/             # AI/Agent SDK code
├── memory/            # Memory subsystem
├── utils/             # Helpers
└── web/               # Web UI
    ├── server.ts
    ├── public/
    │   ├── components/
    │   ├── hooks/
    │   └── utils/
```

### Naming Conventions

- **Files**: kebab-case (`user-manager.ts`)
- **Classes**: PascalCase (`UserManager`)
- **Functions**: camelCase (`getUserById`)
- **Constants**: SCREAMING_SNAKE_CASE (`MAX_RETRIES`)
- **Types/Interfaces**: PascalCase (`UserProfile`)

## Pull Request Process

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

Branch naming:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation
- `refactor/` - Code refactoring
- `test/` - Test additions

### 2. Make Your Changes

- Keep commits focused and atomic
- Write clear commit messages
- Follow existing patterns in the codebase

### 3. Test Your Changes

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build CSS (if changed)
bun run build:css
```

### 4. Submit PR

1. Push your branch
2. Open a Pull Request on GitHub
3. Fill out the PR template
4. Link any related issues

### PR Requirements

- [ ] Tests pass
- [ ] Types check
- [ ] No lint errors
- [ ] Clear description
- [ ] Small, focused changes

## Commit Messages

Follow conventional commits:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting (no code change)
- `refactor`: Code refactoring
- `test`: Tests
- `chore`: Maintenance

Examples:
```
feat(memory): add vector search support
fix(telegram): handle rate limit errors
docs: update installation guide
refactor(agent): simplify prompt generation
```

## Testing

### Running Tests

```bash
bun test                 # All tests
bun test src/memory      # Specific directory
bun test --watch         # Watch mode
```

### Writing Tests

```typescript
import { test, expect, describe } from 'bun:test';

describe('Memory Service', () => {
  test('should store memory', async () => {
    const memory = await memoryService.store({
      content: 'Test content',
      type: 'semantic'
    });

    expect(memory.id).toBeDefined();
    expect(memory.content).toBe('Test content');
  });
});
```

### Test Files

- Place tests next to source files: `memory.ts` → `memory.test.ts`
- Or in `__tests__` directories
- Name test files with `.test.ts` suffix

## Documentation

### Code Comments

- Comment the "why", not the "what"
- Use JSDoc for public APIs

```typescript
/**
 * Stores information in user's memory.
 *
 * @param content - The information to store
 * @param options - Storage options
 * @returns The stored memory with generated ID
 *
 * @example
 * await memoryService.store('User birthday is March 15', {
 *   type: 'semantic',
 *   importance: 0.8
 * });
 */
async function store(content: string, options: StoreOptions): Promise<Memory> {
  // ...
}
```

### Documentation Files

- Use Markdown for docs
- Keep docs updated with code changes
- Include examples where helpful

## Reporting Issues

### Bug Reports

Include:
1. Cobrain version
2. Steps to reproduce
3. Expected behavior
4. Actual behavior
5. Logs/screenshots

### Feature Requests

Include:
1. Problem description
2. Proposed solution
3. Alternatives considered
4. Impact/benefit

## Code of Conduct

- Be respectful and inclusive
- Give constructive feedback
- Focus on the code, not the person
- Help newcomers

## Questions?

- Open an issue for questions
- Check existing issues first
- Join discussions in PRs

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (MIT).
