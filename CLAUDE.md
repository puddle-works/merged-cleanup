<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Swamp

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with `swamp extension search <query>` — prefer `@swamp/*` official extensions first, (b) search local/installed types with `swamp behavior type search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension behavior in `extensions/models/` as a last resort. Use the `swamp` skill for guidance. The `command/shell` behavior is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a behavior covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp behavior type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a behavior (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire behaviors together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp behavior get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp behavior run` calls against the same behavior. Multiple parallel calls against the same behavior contend on the per-behavior lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp behavior type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled; pin them.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. When the extension has a `deno.json`, the `deno.lock` beside it decides which versions are bundled; otherwise the registry's current release does. Always pin explicit versions in `npm:` and `jsr:` import specifiers (e.g., `npm:lodash-es@4.17.21`) — `swamp extension push` warns on unpinned and range specifiers.
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze behavior output (security reports, cost analysis, compliance checks, summaries), create a report extension. Use the `swamp` skill for guidance.
9. **"Workflow" means a swamp workflow.** In this repository the word "workflow" (and "create/run/execute/validate/debug workflow", "automate", "orchestrate", "automated/nightly job") refers to a swamp workflow — a declarative YAML DAG of behavior-method steps authored via `swamp workflow create`. Load and follow the `swamp` skill for these requests. Do NOT interpret these as a request to build an agent task list, spin up worktrees, or schedule a cron/remote agent. Only use those orchestration mechanisms when the user explicitly names one (e.g. "task list", "subagent", "worktree", "cron", "remote agent") or explicitly asks you to do the work yourself step by step rather than author a swamp workflow.
10. **Use swamp, don't bypass it.** Always work through swamp commands — don't go around them with raw shell tools. Use `swamp data query` to find data, not `grep`/`find` on `.swamp/` files. Use behavior methods to interact with resources, not `curl`/`aws`/`gcloud`/`kubectl` when a behavior type already wraps that API — check with `swamp behavior type search`. Use `swamp help` for CLI discovery, not guesswork. Composing with swamp output is fine (e.g. piping `--json` through `jq`) — the anti-pattern is bypassing swamp entirely.
11. **Inspect reports after failures.** When a behavior method or workflow run fails, inspect its generated reports before retrying or changing definitions. Reports run even on failure and capture structured diagnostics — error messages, execution status, arguments, and data output pointers. Use `swamp report get @swamp/method-summary --model <model> --json` for method failures or `swamp report get @swamp/workflow-summary --workflow <workflow> --json` for workflow failures. Run `swamp help report get` to confirm current retrieval syntax.

## Skills

**IMPORTANT:** Always load swamp skills, even when in plan mode. The skills provide
essential context for working with this repository.

- `swamp` - Swamp CLI — behaviors, workflows, data, vaults, extensions, publishing, repos, reports, issues, and troubleshooting
- `swamp-getting-started` - Interactive onboarding for new swamp users

## Getting Started

If you were asked to read a task brief under `tasks/` (a file whose first
line is `<!-- swamp start brief v1 -->`), read that brief, then invoke the
`swamp-getting-started` skill and follow it from its brief entry point.

If the user is new to swamp or asks to get started, or a swamp command you
run shows this repository has no behaviors yet, invoke the
`swamp-getting-started` skill. It checks for existing behaviors itself and walks
new users through an interactive onboarding tutorial.

Otherwise, use the `swamp` skill to work with swamp behaviors.

## Commands

Use `swamp --help` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run `swamp help [<command>...]` — e.g. `swamp help` returns
the full tree, and `swamp help behavior run` scopes to a subtree.

Behaviors (formerly models) are managed with `swamp behavior` — e.g.
`swamp behavior run <name> <method>` (or
`swamp behavior run @<type> <method> <name>` to run against a type
directly). Every `swamp model …` spelling remains supported.
<!-- END swamp managed section -->

## Puddle repo

This repo is a puddle made from `puddle-works/puddle-template` ([ADR-004][adr]).
It holds one puddle: one extension with one bounded purpose.

- `make test` runs every test in `extensions/models/`. One of them checks that
  each workflow is a `workflow-*.yaml` file with its own UUID `id`; swamp skips
  any other file without a word.
- `make contracts-check` and `make guardrails-check` run the shared checks from
  puddle-tooling. Every workflow in `workflows/` needs `maxReruns` and
  `maxWallClock` tags, and a workflow that reads another model's data with
  `data.latest` needs an entry in `contracts.ts`.
- `make publish VISIBILITY=public DRY_RUN=1` runs the publish dry run. Never
  push with `--yes`; `VISIBILITY` must equal `visibility:` in `manifest.yaml`.
- Review reports live in `swamp-extension-review/` and are committed with the
  version they review.
- A web UI is Preact rendered on the server, written with `h()` in `.ts`,
  because the swamp registry rejects `.tsx`. Capture's page works this way
  ([ADR-006][ui]).

[adr]: https://github.com/puddle-works/puddleworks-apps/blob/main/docs/adr/ADR-004-one-repo-per-puddle.md
[ui]: https://github.com/puddle-works/puddleworks-capture/blob/main/docs/adr/ADR-006-preact-on-the-server.md

<!-- BEGIN puddleworks-factory app section -->
# merged-cleanup

Clean up after a merged PR. Built by puddleworks-factory from the app spec `merged-cleanup`;
the specification below was agreed before it was handed over.

Spec: [where it was agreed](http://127.0.0.1:3002/requests/2c4c963a-b14d-403f-9b1f-2bdabbc71c19), version 2, hash `9442f5b008d8f5d6f1939c6c27cbf3ea7a52585995f3a795ee526ab50e937ca9`.

## Bounded purpose

For merged PRs in the repository of the current directory, report whether each one's worktree and branches are safe to clean up (check), and clean up those that are (clean): remove the worktree, delete the local branch and origin's branch with a lease on the PR's head, and fast-forward main.

## Inputs (the run form)

- `pr` (integer, `0`) — A PR number to check or clean up; 0 means none named.
- `prs` (string, empty) — Up to 5 more PR numbers, comma-separated, digits only; together with pr at most 5. With none named, the latest 3 merged PRs that still have a worktree at their head.

## Settings (set once per model instance)

None.

## Output

Per PR: its number, title, verdict (clean, primary, dirty, locked, ahead, absent, open, closed, error), worktree, branch and a one-line reason; for clean, each step (remove worktree, delete local branch, delete origin branch, fast-forward main) as done, already done, skipped with why, or failed with the error; then a one-line summary, or "Nothing to clean up" when there is none.

## Out of scope

- Merging, closing or approving PRs
- Routing turns and the ask-once gate itself: those stay in puddlerouter and @puddleworks/recipes; this request only adds the recipe that uses the gate
- Removing puddlerouter's own merged check (_lib/merged.ts) and its tests once the recipe is live (follow-up work in puddlerouter)
- Removing worktrees that are dirty, locked, ahead of the PR's head, or not at the head of a merged PR
- Any force: no git worktree remove --force, no git branch -D, no plain --force push
- Repositories other than the one the current directory is in, and remotes other than origin
- Linking, repointing or otherwise changing Orca worktree lineage

Anything on this list, or anything beyond the purpose above, needs a new
spec. Do not add it here, and do not add permissions or secrets the
settings above do not name.

## The build

The draft is finished: `extensions/models/merged_cleanup.ts` has `check`,
`clean` and a read-only `run`, and the tests need the permissions in the
Makefile's `test` target, `README.md` and `.github/workflows/ci.yml`. Keep
the argument names: the workflows and the run form depend on them.

A web UI is Preact rendered on the server, written with `h()` in `.ts`,
because the swamp registry rejects `.tsx`. The Factory's viewer works this
way.

## Recipe

These phrases were agreed for this app:

- "22 is merged": After one yes: PR 22: worktree removed, local branch deleted, origin branch deleted, main fast-forwarded (each step shown as done, already done, skipped with why, or failed with the error), then a one-line summary.
- "merged": After one yes: the same steps for each of the latest 3 merged PRs that still have a worktree at their head, then a one-line summary; or "Nothing to clean up" when there are none.

No recipe was drafted, as one recipe can't take both phrases. Two were
written by hand: `workflows/workflow-merged-cleanup-recipe.yaml` ("N is
merged") and `workflows/workflow-merged-cleanup-latest-recipe.yaml` (a bare
"merged"). Both are listed in `manifest.yaml`, which is labelled
`puddlerouter-recipe`, and readiness checks them.

<!-- END puddleworks-factory app section -->
