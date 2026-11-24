# pi-extensions

English | [简体中文](README.zh-CN.md)

A collection of extensions for the Pi coding agent (npm package name `pi-timer`). One repository covers Claude Code-style tool rendering, response timing, a custom status bar, per-model thinking-level memory, conversation archiving, multi-model collaboration, and session rewind.

There is no build step: Pi loads the TypeScript sources under `.pi/extensions/` directly, and `/reload` picks up changes.

## Extensions

| Entry point | What it does | How it activates |
| --- | --- | --- |
| `.pi/extensions/claude-style/index.ts` | Takes over rendering for `read`, `bash`, `grep`, `find`, `ls`, `edit`, and `write` (plus `powershell` on Windows), and adds a codemode result view | Automatic |
| `.pi/extensions/response-timer.ts` | Times each turn: renders `⠼ Working...` while running and appends `Done: Xs` when finished | Automatic |
| `.pi/extensions/custom-status-bar.ts` | Custom footer: model and thinking level, context window, project, Git branch, context usage, Pi home, and session ID | Automatic |
| `.pi/extensions/model-thinking-memory.ts` | Remembers the last thinking level per model; restores the previous model and level on new sessions and forks | Automatic |
| `.pi/extensions/conversation-logger.ts` | Saves the user and assistant text of every turn as Markdown | Automatic |
| `.pi/extensions/model-delegation/index.ts` | Registers the `delegate_to_model` tool for multi-model work; `/model-delegation-config` configures submodels | Tool call + slash command |
| `.pi/extensions/rewind-claude/index.ts` | Claude Code-style rewind of code and conversation | `/rewind-claude`, double `Esc` on an empty input |

Every extension except `custom-status-bar` guards against duplicate registration, so loading the same extension more than once in a process registers it only once.

## Installation and activation

Extensions rely on `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` supplied by the Pi runtime (see `peerDependencies`), so no separate installation is required. Pi executes the `.ts` sources natively; development was verified on Node.js 24.22.2.

### Project-local (recommended)

This repository is itself a runnable Pi project. Start Pi in the repository and, once the project is trusted, Pi discovers the extensions under `.pi/extensions/`:

1. Run `pi` from the repository root.
2. Confirm the project trust prompt on first entry.
3. Run `/reload` in the session after changing an extension.

To reuse an extension in another project, copy (or symlink) the needed files or directories into that project's `.pi/extensions/`. A single-file extension is `<name>.ts`; a multi-file extension is `<name>/index.ts`.

### Global

Place extensions in Pi's global extension directory to enable them for every project:

```text
~/.pi/agent/extensions/<name>.ts
~/.pi/agent/extensions/<name>/index.ts
```

### Trying an extension ad hoc

```bash
pi -e ./.pi/extensions/response-timer.ts
```

`-e` loads one extension and does not support hot reload, which makes it useful for verifying a change.

### Installing as a Pi package

The `pi.extensions` field in `package.json` matches the entry points under `.pi/extensions/`, so installing the repository as a package enables the same set of extensions as project-local discovery:

```bash
pi install /path/to/pi-extensions
```

## Extension details

### claude-style

Recreates the Claude Code tool-call presentation: tool titles, argument summaries, collapsible results, and error coloring. It wraps Pi's native tool definitions and replaces only `renderCall` / `renderResult`, so execution and result data stay native. The codemode view additionally shows the script summary, nested calls, aggregated cost across model calls, and graceful degradation for over-wide content and images.

### response-timer

`agent_start` / `agent_settled` guarantee one measurement per turn. While a turn runs, Pi's built-in Working line is hidden and a timing line renders above the editor; when the turn finishes, the duration is written to session history for later inspection.

### custom-status-bar

Takes over the footer through `ctx.ui.setFooter` and renders:

```text
model-id[level] 128k · project · branch · Context 42% used
pi-home:~/.pi/agent(session-id)
```

Colors use fixed bright ANSI values and Nerd Font icons, so the bar ignores Pi themes; wide content wraps to the terminal width.

### model-thinking-memory

Persists the level on `thinking_level_select` and restores it on `model_select` and `session_start`. With no history it defers entirely to Pi's defaults and capability clamping, so it never overrides Pi's own policy. A corrupted store raises a warning instead of interrupting the session.

### conversation-logger

Writes only on `turn_end`, and only when the turn stops calling tools (`stopReason !== "toolUse"`). The output contains plain text only; thinking, tool calls, and internal injected markers are filtered out. File names follow `<YYYY-MM-DD-HHmmss>_<first 20 chars>_<first 6 chars of md5>.md` and are written atomically with `wx`, appending `_2`, `_3` suffixes on collision.

### model-delegation

The former `subagent` tool and `/subagent-models` command are now `delegate_to_model` and `/model-delegation-config`, without legacy aliases. Configuration and diagnostics retain their existing paths; no data migration is needed.

The main model hands work to another model through the `delegate_to_model` tool:

- `access: "read"` covers reviews and research; `access: "write"` lets the submodel modify the project and run commands, requires user confirmation before the call, and leaves changes in place when the call is cancelled or fails.
- The submodel reuses the main session's credentials; nothing is copied or persisted.
- Results over 50KB or 2000 lines are truncated, with the full text written to a temporary file.
- Failures write a redacted diagnostic log that separates network retries from model-side errors.

`/model-delegation-config` opens a configuration panel for the default submodel and per-model thinking levels. Models resolve in this order: the existing thread's model, the configured default, then the main session model. The thinking level prefers the thread, then the per-model setting, then the scoped setting or the model's supported default.

### rewind-claude

Run `/rewind-claude`, or press `Esc` twice on an empty input (with text in the input, the double `Esc` saves and clears the draft; press `↑` to restore it). Any earlier prompt can become a checkpoint, with these actions:

- Restore code and conversation
- Restore conversation
- Restore code
- Summarize from here / Summarize up to here
- Never mind

Checkpoints track only Pi's `edit` and `write` tools; Bash, external editors, symlinks, and hard links are out of scope. Restoring a session creates a real Pi Fork Session and keeps the model and thinking level from before the fork. See [.pi/extensions/rewind-claude/README.md](.pi/extensions/rewind-claude/README.md) for details.

## Data and configuration locations

| Data | Location | Produced by |
| --- | --- | --- |
| Conversation logs | `<project>/.pi/logs/` | conversation-logger |
| Per-model thinking levels | `<Pi agent directory>/model-thinking-levels.json` | model-thinking-memory |
| Submodel configuration | `<Pi agent directory>/subagent-models.json` | model-delegation |
| Collaboration diagnostics | `<Pi agent directory>/model-collaboration-diagnostics/<sessionId>.jsonl` | model-delegation |
| Rewind checkpoints | `<session file>.rewind-claude/` (`manifest.json` + `blobs/`, up to 100 checkpoints); falls back to a temporary directory when there is no session file | rewind-claude |

`<Pi agent directory>` is whatever `getAgentDir()` returns, by default `~/.pi/agent`.

## Repository layout

```text
.
├── .pi/extensions/           # extension sources, loaded directly by Pi
│   ├── *.ts                  # single-file extensions: timer, logger, status bar, thinking memory, session naming
│   ├── claude-style/         # Claude Code-style tool rendering and codemode view
│   ├── model-delegation/     # delegate_to_model tool, config panel, progress, diagnostics
│   └── rewind-claude/        # /rewind-claude command, checkpoint store, interaction
├── tests/                    # behavior tests for top-level extensions
├── docs/                     # design notes and module docs
├── package.json              # Pi package manifest and scripts
└── tsconfig.json             # strict type-check configuration
```

## Development

```bash
npm test                            # top-level tests + Rewind tests
npm run typecheck                   # strict type checking (needs a local tsc)
cd .pi/extensions/rewind-claude && npm test   # Rewind tests only
```

`typescript` and `@types/node` are declared in `devDependencies`, so `npm run typecheck` works after `npm install`.

Conventions:

- Four spaces, double quotes, semicolons; ESM imports carry the explicit `.ts` extension.
- Tests use Node's built-in `node:test` and `node:assert/strict`, with `*.test.ts` file names.
- Shared top-level behavior tests live in `tests/`; feature-internal tests sit next to their implementation (`rewind-claude`).
- For file or TUI behavior, assert rendered output or persisted results in temporary directories instead of implementation details.

## Known limitations

- **`Summarize up to here` boundary**: when a session is short enough that Pi returns `Nothing to compact (session too small)`, the `session_before_compact` hook never fires, so the action reports an error and leaves the session unchanged.
- **Coexistence with the older extension**: if `@ayulab/pi-rewind` is also enabled, restoring a session still prompts `Sync files?`. For a single Claude Code-style interaction, disable it in Pi's `packages` configuration.
