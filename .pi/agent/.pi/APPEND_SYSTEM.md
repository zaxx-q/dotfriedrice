# Pi Extension Development — Quick Reference

## Official documentation (local)

All docs live under the bun-installed pi package:

```
~/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/
```

| Topic                      | Relative path                   |
| -------------------------- | ------------------------------- |
| **Extensions API**         | `docs/extensions.md`            |
| **TUI / Custom rendering** | `docs/tui.md`                   |
| **Themes**                 | `docs/themes.md`                |
| **Keybindings**            | `docs/keybindings.md`           |
| **Sessions / branching**   | `docs/sessions.md`              |
| **Compaction**             | `docs/compaction.md`            |
| **Custom providers**       | `docs/custom-provider.md`       |
| **Models**                 | `docs/models.md`                |
| **Packages**               | `docs/packages.md`              |
| **SDK**                    | `docs/sdk.md`                   |
| **RPC**                    | `docs/rpc.md`                   |
| **Settings**               | `docs/settings.md`              |
| **Environment variables**  | `docs/environment-variables.md` |
| **Examples**               | `examples/extensions/`          |

**Always read the actual docs** before implementing — they are the canonical source. This file is a cheat sheet.

## Key examples (local)

All at `~/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`:

| Example                          | What it demonstrates                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| `hello.ts`                       | Minimal tool registration                                               |
| `todo.ts`                        | Stateful tool with persistence, `renderCall`/`renderResult`, `/command` |
| `dynamic-tools.ts`               | Register tools after startup, `setActiveTools`                          |
| `widget-placement.ts`            | Widget above/below editor                                               |
| `permission-gate.ts`             | `tool_call` event blocking                                              |
| `custom-compaction.ts`           | `session_before_compact` / `session_compact`                            |
| `plan-mode/`                     | Full plan mode (events, commands, shortcuts, flags, widgets, status)    |
| `preset.ts`                      | Saveable presets (model, tools, thinking), SelectList UI                |
| `tools.ts`                       | Toggle tools on/off, SettingsList UI                                    |
| `question.ts`                    | Tool with user interaction (`ui.select`)                                |
| `questionnaire.ts`               | Multi-step wizard with `ui.custom()`                                    |
| `structured-output.ts`           | `terminate: true` for final structured output                           |
| `truncated-tool.ts`              | Output truncation with `truncateHead`                                   |
| `tool-override.ts`               | Override built-in tools                                                 |
| `ssh.ts`                         | Remote execution with `registerFlag`                                    |
| `subagent/`                      | Spawning sub-agents                                                     |
| `handoff.ts`                     | Cross-provider model handoff                                            |
| `snake.ts` / `space-invaders.ts` | Games with `ui.custom()`                                                |

## Environment

- **OS:** Fedora Linux 44 (Sway)
- **Shell:** zsh
- **Pi install:** `~/.cache/.bun/bin/pi` (bun global)
- **Runtime:** bun (via mise), node is just symlink for bun.
- **Global extensions:** `~/.pi/agent/extensions/`
- **Project extensions:** `.pi/extensions/`
- **This dotfiles repo extensions:** `.pi/agent/extensions/` (the `agent` subdir within `.pi`)

## Available imports

| Package                           | Purpose                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, events, `keyHint`, `DynamicBorder`, `BorderedLoader`, `CustomEditor`, `highlightCode`, truncation utils, `withFileMutationQueue`, `CONFIG_DIR_NAME`) |
| `typebox`                         | Schema definitions for tool parameters (`Type.Object`, `Type.String`, etc.)                                                                                                                               |
| `@earendil-works/pi-ai`           | AI utilities (`StringEnum` for Google-compatible enums)                                                                                                                                                   |
| `@earendil-works/pi-tui`          | TUI components (`Text`, `Box`, `Container`, `Spacer`, `Markdown`, `SelectList`, `SettingsList`, `Input`, `matchesKey`, `Key`, `visibleWidth`, `truncateToWidth`)                                          |

npm dependencies and Node.js built-ins (`node:fs`, `node:path`, etc.) also work.

## Extension structure patterns

**Single file** (simplest):

```
~/.pi/agent/extensions/my-extension.ts
```

**Directory with index.ts** (multi-file):

```
~/.pi/agent/extensions/my-extension/
├── index.ts        # Entry point (exports default function)
├── core.ts         # Pure logic, types, helpers
└── utils.ts
```

**With npm dependencies:**

```
~/.pi/agent/extensions/my-extension/
├── package.json    # dependencies here
├── node_modules/
└── index.ts
```

## Extension skeleton

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Events
  pi.on("session_start", async (_event, ctx) => {
    /* ... */
  });

  // Tools
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({
      text: Type.String({ description: "Input text" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Result: ${params.text}` }],
        details: {},
      };
    },
  });

  // Commands
  pi.registerCommand("mycmd", {
    description: "Do something",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Args: ${args}`, "info");
    },
  });
}
```

## Key API patterns

### State persistence

Store state in tool result `details` — it survives branching and session restore. Replay from `ctx.sessionManager.getBranch()` on `session_start`.

### Custom rendering

Tools can define `renderCall` and `renderResult`. Return `Text` or `Box` components. The default shell handles padding — use `new Text(content, 0, 0)`.

### String enums

Use `StringEnum` from `@earendil-works/pi-ai` instead of `Type.Union`/`Type.Literal` — the latter breaks Google's API.

### Output truncation

Tools **must** truncate output. Use `truncateHead`/`truncateTail` from the pi package. Default limits: 50KB / 2000 lines.

### File mutation safety

If your tool writes files, wrap mutations in `withFileMutationQueue(absolutePath, async () => { ... })` to avoid race conditions with parallel built-in `edit`/`write` calls.

### Dynamic tool activation

Register many tools at load, keep a subset active via `pi.setActiveTools()`. A loader tool can add more during execution — pi detects additive changes and exposes new definitions before the next model request.

### UI interaction

- `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.input()` — blocking dialogs
- `ctx.ui.notify()` — non-blocking notification
- `ctx.ui.custom()` — full custom TUI component (replaces editor until `done()`)
- `ctx.ui.setStatus()`, `ctx.ui.setWidget()`, `ctx.ui.setFooter()` — persistent UI
- `ctx.ui.custom(..., { overlay: true })` — floating overlay

### Useful TUI components (from pi-tui)

- `SelectList` — selection dialog
- `SettingsList` — toggles
- `BorderedLoader` — async operation with cancel
- `DynamicBorder` — themed border line
- `matchesKey(data, Key.enter)` — keyboard detection

## Testing & verification

Pi extensions don't have a formal test framework. When building extensions:

- **Test interactively:** `pi -e ./my-extension.ts` for quick iteration
- **Verify behavior by running:** use the tool/command, check output
- **For complex pure logic** (reducers, formatters, state replay): extract to a separate `core.ts` with zero pi deps, then unit test with vitest if it makes sense
- **Don't force tests** where interactive verification is sufficient — most extensions are small enough that running them IS the test

## Running extensions

```bash
# Quick test (one-off)
pi -e ./extension.ts

# Install globally
cp extension.ts ~/.pi/agent/extensions/

# Hot-reload after changes (in interactive mode)
/reload
```

## Lifecycle events (key ones)

```
session_start → resources_discover → [user prompt] →
  before_agent_start → agent_start →
    turn_start → context → tool_call → tool_result → turn_end →
  agent_end → agent_settled
```

- `tool_call` — can **block** execution, mutate `event.input`
- `tool_result` — can **modify** result (content, details, isError)
- `before_agent_start` — can inject messages, modify system prompt
- `context` — can filter/modify messages before LLM call
- `session_shutdown` — cleanup resources
