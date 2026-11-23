# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript package of Pi and Codex extensions.

- `.pi/extensions/` contains the runtime extensions. Standalone modules include `response-timer.ts`, `conversation-logger.ts`, and `model-thinking-memory.ts`; grouped features live in `claude-style/` and `rewind-claude/`.
- `tests/` contains tests for the top-level extensions and integrations. Rewind-specific tests are co-located in `.pi/extensions/rewind-claude/`.
- `.codex/hooks.json` and `.codex/scripts/` define the Codex conversation logging hook. `docs/` contains product notes and design decisions; `hello.html` is a standalone demo.
- `package.json` declares Pi entrypoints and scripts; `tsconfig.json` enables strict, no-emit type checking.

## Build, Test, and Development Commands

There is no bundle or build step; Pi loads the TypeScript extensions directly.

- `npm test` runs all root tests plus the Rewind test files.
- `npm run typecheck` runs strict TypeScript checking and syntax-checks the Codex logger script.
- `cd .pi/extensions/rewind-claude && npm test` runs only the Rewind extension tests.

## Coding Style & Naming Conventions

Use four spaces, double quotes, semicolons, and ESM imports with explicit `.ts` extensions. Keep TypeScript strict and prefer existing Node standard-library APIs and local helpers. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and lower-kebab-case for extension directories and files (for example, `response-timer.ts`). No formatter or linter is configured; run `npm run typecheck` and match surrounding code.

## Testing Guidelines

Tests use Node’s built-in `node:test` runner with `node:assert/strict`; no coverage threshold is configured. Name files `*.test.ts` and describe observable behavior in each test name. Put shared top-level behavior tests in `tests/` and feature-internal tests beside the implementation. For file or UI behavior, use temporary directories and assert rendered output or persisted results rather than implementation details.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style subjects such as `feat(response-timer): ...` and `feat: ...`. Use a concise imperative subject with an optional scope (`fix(claude-style): ...`, `test: ...`). Keep commits focused. Pull requests should explain behavior changes, list validation commands and results, link an issue when applicable, and include screenshots or terminal output for TUI/rendering changes. Call out changes to Pi/Codex hooks or generated log behavior.

## Runtime and Configuration Notes

Extensions may write conversation logs under `.pi/logs/` and model preferences through the Pi agent directory. Do not hardcode personal paths or credentials. Preserve the peer dependency contract in `package.json`, and avoid committing generated session logs with source changes.
