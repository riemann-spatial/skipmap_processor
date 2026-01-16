# OpenSkiData Processor Guidelines

## Docker Development Environment

This project runs in a containerized environment. All commands should be executed within the Docker container.

### Setup

- Start development environment: `docker compose up -d`
- Access container shell: `docker compose exec app bash`

### Build & Test Commands (run inside container)

- Build: `docker compose exec app npm run build`
- Format code: `docker compose exec app npm run format`
- Test all: `docker compose exec app npm test`
- Test single file: `docker compose exec app npx jest path/to/file.test.ts`
- Type check: `docker compose exec app npm run check-types`
- Update test snapshots: `docker compose exec app npm run record-tests`
- Run processor: `docker compose exec app ./run.sh`
- Processing scripts:
  - `docker compose exec app npm run download`
  - `docker compose exec app npm run prepare-geojson`

Run processing with a small BBOX for testing:

```bash
BBOX=[132.34,34.78,132.40,34.84]
```

Use a larger BBOX to test performance implications of a change:
`docker compose exec app bash -c "BBOX=[-125,49,-115,52] ./run.sh`

## Code Style & Conventions

- TypeScript with strict mode enabled
- Don't use `any` type. Be explicit with types.
- Interfaces with explicit typing for all data structures
- PascalCase for classes/interfaces, camelCase for functions/variables
- Use clear, descriptive variable names
- Keep files under 200-300 lines; refactor when approaching this limit
- Test files named with patterns: `.unit.test.ts` or `.int.test.ts`
- Stream-based data processing with functional programming patterns
- Async/await for Promise-based operations
- Uses Prettier for code formatting

## Development Principles

### Scope and Changes

- Focus only on areas relevant to the task
- Do not modify unrelated code
- Ask for clarification if requirements are unclear
- Avoid changing proven patterns and architecture unless explicitly instructed
- Consider what other methods or areas might be affected by changes
- Remove unneeded code once it has been replaced by a different implementation

### Problem Solving

- Always prefer simple solutions
- Exhaust all options with existing implementation before introducing new patterns or technologies
- When introducing new patterns, remove old implementations to avoid duplicate logic
- Check for existing similar functionality before writing new code

### Testing

- Write thorough tests for all major functionality
- Account for different environments: dev, test, and prod
- Mock data only in tests, never in dev or prod
- Never add stubbing or fake data patterns that affect dev or prod environments

### Configuration

- Never overwrite .env files without first asking and confirming
