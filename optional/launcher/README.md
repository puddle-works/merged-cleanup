# Launcher (optional)

Only for a puddle that ships a launcher ([ADR-003][adr3]): a small Go
executable that runs the puddle in a container so requesters never see swamp.
Most puddles do not need this.

To use it, move `Containerfile` to the repo root, replace the `TODO` lines, and
add `cmd/<app>/` with the launcher. The Go launcher library
(`puddle-works/puddlerun`) is not published yet, so no Go skeleton is included.

[adr3]: https://github.com/puddle-works/puddleworks-apps/blob/main/docs/adr/ADR-003-cali-inspired-puddle-launchers.md
