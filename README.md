# puddle-template

Template for a puddle repo ([ADR-004][adr]): one repo per puddle, created from
this one. A repo made from it passes `make test` and a publish dry run before
anything is written.

## What is in it

| Path | What it is |
|---|---|
| `.swamp.yaml`, `.gitignore`, `CLAUDE.md` | Swamp repo files from `swamp repo init` |
| `extensions/models/` | The puddle's extension and its tests. Ships with a placeholder `example.ts` |
| `workflows/` | Swamp workflows. Each one needs a `workflow-*.yaml` file name, its own UUID `id`, and `maxReruns` and `maxWallClock` tags. swamp skips a file without the name or the id |
| `manifest.yaml` | The extension's publish manifest (placeholder; `models:` lists bare file names) |
| `contracts.ts` | Maps model instances that workflows read to the data they write |
| `Makefile`, `puddle.mk` | `make test`, `contracts-check`, `guardrails-check`, `publish` |
| `.github/workflows/ci.yml` | Tests plus the reusable checks and publish dry run from [puddle-tooling][tooling] |
| `optional/launcher/` | Containerfile skeleton for a puddle that ships a launcher |

## Make a puddle from it

Click **Use this template** on GitHub, or:

```sh
gh repo create puddle-works/<slug> --template puddle-works/puddle-template --private
```

Then replace the placeholders:

1. Rename the extension in `manifest.yaml`, `extensions/models/` and `contracts.ts`
   (delete `example.ts`, its test and `workflows/workflow-example.yaml` once
   yours exist).
2. Rewrite this README and the puddle section of `CLAUDE.md`.
3. Set `visibility:` in `manifest.yaml` (and `visibility:` in `ci.yml`). The repo's
   visibility follows the extension's.
4. Add the `SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` repository secrets (see
   [puddle-tooling][tooling]) so the publish dry run can run.
5. Run `swamp repo init --force --tool claude` so the repo gets its own `repoId`.

## A web UI

A web UI is Preact rendered on the server, written with `h()` in `.ts`, because
the swamp registry rejects `.tsx`. Capture's page works this way ([ADR-006][ui]).

## Checks

```sh
make test
make contracts-check
make guardrails-check
make publish VISIBILITY=private DRY_RUN=1   # stops after the dry run
```

`puddle.mk` fetches the checks from the puddle-tooling release named by
`TOOLING_REF` (default `v0.1.1`). Move to a newer release by changing it there
and the `@vX.Y.Z` and `tooling-ref` in `ci.yml` together.

[adr]: https://github.com/puddle-works/puddleworks-apps/blob/main/docs/adr/ADR-004-one-repo-per-puddle.md
[tooling]: https://github.com/puddle-works/puddle-tooling
[ui]: https://github.com/puddle-works/puddleworks-capture/blob/main/docs/adr/ADR-006-preact-on-the-server.md
