# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@hazrid1993/pi-advisor` is a [pi](https://github.com/earendil-works/pi-coding-agent) extension. A second, user-picked model reviews the main agent's turns using read-only `read`/`grep`/`find` tools, then either stays silent or calls `advise(note, severity)`. That note is injected back into the main session as an `<advisory>` message. The design is a port of the advisor in `can1357/oh-my-pi`, rebuilt on pi's public extension API.

## Commands

```bash
pnpm install                 # lockfile is pnpm (packageManager: pnpm@9); README also shows npm
pnpm typecheck               # tsc --noEmit — there is no build step
pnpm test                    # vitest run (all __tests__/*.test.ts)
pnpm vitest run __tests__/runtime.test.ts            # one file
pnpm vitest run __tests__/runtime.test.ts -t "name"  # one test by name
pi -e ./advisor.ts           # load the extension into a local pi session for a manual check
```

Tests use fake completions and need no API key. They run serially in a single fork (`vitest.config.ts`) because the tool tests share temp dirs.

## Packaging constraints

- **No compile step.** pi loads the TypeScript source directly (`package.json` → `pi.extensions: ["./advisor.ts"]`), and npm publishes `advisor.ts` + `src/` as-is. Relative imports use the `.js` suffix (`./src/runtime.js`).
- Pi supplies the host-provided modules (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`) to extensions. They must be `"*"` peer deps and must never appear in `dependencies`. Pi warns about that and would install a duplicate copy that bypasses its module mapping. Pin them in `devDependencies` to the pi version the extension is validated against (currently 1.5.0, with `typebox` matching pi's own pin). Import `Type` from `typebox`, as pi's examples do. Pi ≥1.0 is required because the advisor calls its model through `ctx.modelRegistry.streamSimple()`. Do not use pi-ai's `/compat` entrypoint or plain `stream`, which ignores `reasoning`.
- When you bump the pi dev deps, `__tests__/usage-invariant.test.ts` reads pi-ai's installed `dist/api/openai-completions.js` source and checks that `usage.input` counts uncached tokens only. `/advisor status` cache-hit math depends on that. If the test fails, pi-ai internals changed. Do not loosen the test. pi-ai 1.5 made `parseChunkUsage` model-aware (it calls `calculateCost` and, for OpenRouter models, `applyOpenRouterReportedCost`), so the test stubs those out to keep evaluating the input/cache split in isolation.

## Architecture

The data flow is pi event → `advisor.ts` → `AdvisorRuntime` (`src/runtime.ts`) → `runAdvisorReview` (`src/agent.ts`) → `host.sendAdvice` → `pi.sendMessage`.

- **`advisor.ts` is the only file that touches `ExtensionAPI`.** It holds the module-level `config` and `runtime` singletons, re-reads config on `session_start`, builds a `ReviewCtx` for each event, and dispatches the `/advisor` subcommands and TUI pickers (`src/ui.ts`). Everything under `src/` is pi-agnostic enough to unit-test with plain objects.
- **Capture is decoupled from scheduling.** `turn_end` always serializes the turn (`src/transcript.ts` `serializeTurn`) and captures new user prompts into the staged buffer. Triggers (`turn_end`, `tool_error`, `tool_result`, `agent_settled`, `mid_pause`, `input`) only decide *when* `requestReview()` runs. Turning a trigger off must never lose context.
- **The runtime keeps two context layers, both bounded by `contextChars`:**
  1. `#contextBuffer`: staged, not-yet-reviewed per-turn deltas. When a review commits, the buffer is *moved* into a `PendingTurn`, so captures that arrive later go to the next review.
  2. `#advisorHistory`: the advisor's persistent conversation. Every request sends it **unchanged as the leading prefix** and appends exactly one new user message. Provider prompt caching depends on this byte-identical prefix. Never rewrite or reorder earlier history messages. Trimming drops the oldest *half* of review segments, cutting only at user-message boundaries so toolCall/toolResult pairs stay together. Persisted tool results are capped at 10k chars.
- **Concurrency discipline (ported from oh-my-pi). Preserve it when you touch `requestReview`/`#drain`:**
  - *Latest-wins generation:* `#generation` is captured synchronously before any `await` and re-checked after each one. At most one turn is pending. A superseded pending turn's deltas are merged into the newer turn, not dropped. A stale result is discarded before retry accounting.
  - *Epoch + lifecycle `AbortController`:* `reset()`/`dispose()` (called on session start, compaction, tree navigation, and shutdown) bump the epoch and abort in-flight work. Per-turn signals are composed with `AbortSignal.any`, never merged into the shared controller.
  - *Single-flight `#busy` drain*, 1s abortable retry backoff, and the backlog is dropped after `maxRetries` consecutive failures.
- **Self-trigger guards:** `advisor.ts` forwards `event.source`, and `input` events with `source: "extension"` (fired by any extension's `pi.sendUserMessage`) are ignored. As of pi 1.3, the advisor's own `pi.sendMessage` custom messages don't fire `input`. Reviews triggered by `agent_settled` are delivered with `forceNonTriggering`, so advice can't start a new run that settles again. Advice is deduped at delivery through `#recentKeys`, and the session update carries a recent-advice preamble.
- **`src/tools.ts`** re-implements read-only fs tools. `resolveReadonlyPath` confines them to the session cwd. No write or exec path may be added. The only use of `child_process` is grep's optional `rg` fast path, which falls back to a Node file walk.
- **`src/prompts.ts`** is ported verbatim from oh-my-pi. Treat it as upstream text, not something to tune casually.
- **Instructions:** `instructionsMode` (`project` | `global` | `none`) selects `<cwd>/.pi/advisor.md` (used only when the project is trusted) or `~/.pi/agent/extensions/pi-advisor-instructions.md`. The selected text is appended to the system prompt in a `<project-advisor-instructions>` block.

`docs/architecture.md` explains the overall design and its oh-my-pi lineage. Its transcript description is out of date: `buildAdvisorDelta`, cursors, `contextEntries`, and branch windows were replaced by turn_end-payload serialization plus the persistent history. For current behavior, trust the header comments in `src/runtime.ts` and `src/transcript.ts`.

## Testing seams

- `new AdvisorRuntime(host, config, review?)` accepts an injected `review` function, so queue, epoch, retry, and delivery logic can be tested without a model.
- `__tests__/wiring.test.ts` registers `advisor.ts` against a fake `pi` with a temporary `PI_CODING_AGENT_DIR` config. Use it to check that event payload fields reach the runtime.
- `runAdvisorReview(..., config)` takes `config.complete`. `__tests__/helpers.ts` provides `fakeModel`, `assistantMessage`, and scriptable fake completions.
- The retry backoff and `waitForCatchUp` polling go through `abortableDelay`, which calls `globalThis.setTimeout` on purpose so tests can monkeypatch it.

## Adding a config option

Recent releases (e.g. `turnInterval`, `cacheRetention`) touched the same set of places:
1. `AdvisorConfig`, `DEFAULT_CONFIG`, and `normalizeConfig` in `src/index.ts`. `normalizeConfig` tolerates missing or invalid fields so old config files keep loading. Keep unknown legacy keys silently accepted.
2. A `handleX` function in `advisor.ts`, a dispatch case, and an `ADVISOR_SUBCOMMANDS` entry for autocomplete.
3. Tests in `__tests__/config.test.ts`, plus `runtime.test.ts` if behavior changes.
4. The command and config tables in `README.md`.

Config is persisted at `~/.pi/agent/extensions/pi-advisor.json` (resolved via pi's `getAgentDir()`, so it respects `PI_CODING_AGENT_DIR`).

## Conventions

- Style: tabs, double quotes, `#private` class fields. JSDoc comments are dense and explain *why*. Tags like `B2`/`B5`/`G2` refer to past bug fixes. Keep that comment density when editing.
- Release commits are titled `release X.Y.Z: <summary>`. They bump `package.json` `version` and update README/docs in the same commit. When the validated pi version changes, update the README badge and the Development section.
