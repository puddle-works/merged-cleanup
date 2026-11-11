/**
 * A real git setup for the tests: a bare `origin` standing in for GitHub, a
 * main clone, and worktrees made the way Orca makes them. `fakeSwamp` gives a
 * `RunModel` that does what the `@swamp/git` built-ins do with the git CLI,
 * runs this extension's own `@swamp/git` methods for real, and answers
 * `@webframp/github` from a table.
 *
 * No tests here; the other test files use it.
 *
 * @module
 */
import { extension } from "../git_cleanup.ts";
import { listMergedPrs, viewPr } from "../github_cleanup.ts";
import type { ModelCall, RunModel, RunResult } from "./cleanup.ts";

/** One answer `@webframp/github` gives for a PR. */
export interface FakePr {
  title: string;
  state: "MERGED" | "OPEN" | "CLOSED";
  headRefOid: string;
  /** The PR's own branch, as GitHub names it. */
  headRefName: string;
  /** When it was merged; only a merged PR has one. */
  mergedAt?: string;
  /** Its last activity: the merge, or a comment after it. */
  updatedAt?: string;
}

const ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Run git in `cwd`; never throws. */
export async function git(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: ENV,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout).trim(),
    stderr: dec.decode(out.stderr).trim(),
  };
}

/** Run git in `cwd`; throws on a non-zero exit. */
export async function ok(cwd: string, ...args: string[]): Promise<string> {
  const res = await git(cwd, ...args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/** The temp repos one test works in. */
export interface Repos {
  root: string;
  origin: string;
  /** The main checkout, the "current directory". */
  main: string;
  /** A second clone, where "GitHub" merges PRs and others push. */
  other: string;
  /** The default branch: main, or master for a repo made with `trunk: "master"`. */
  trunk: string;
  /** Remove everything. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * origin with one commit on its default branch (main unless `trunk` says
 * master), the main clone, and another clone.
 */
export async function repos(
  opts: { trunk?: "main" | "master" } = {},
): Promise<Repos> {
  const trunk = opts.trunk ?? "main";
  const root = await Deno.realPath(await Deno.makeTempDir());
  const origin = `${root}/origin.git`;
  const main = `${root}/repo`;
  const other = `${root}/other`;
  await ok(root, "init", "-q", "--bare", "-b", trunk, origin);
  for (const dir of [main, other]) {
    await ok(root, "clone", "-q", origin, dir);
    // The URL is GitHub's, as Capture's repos are; git reaches the bare repo.
    await ok(dir, "config", "remote.origin.url", URL_);
    await ok(dir, "config", `url.${origin}.insteadOf`, URL_);
  }
  await Deno.writeTextFile(`${main}/README.md`, "hello\n");
  await ok(main, "add", "README.md");
  await ok(main, "commit", "-q", "-m", "first");
  await ok(main, "push", "-q", "-u", "origin", trunk);
  await ok(other, "pull", "-q", "origin", trunk);
  await ok(other, "branch", "-q", `--set-upstream-to=origin/${trunk}`, trunk);
  return {
    root,
    origin,
    main,
    other,
    trunk,
    [Symbol.asyncDispose]: () => Deno.remove(root, { recursive: true }),
  };
}

/** The GitHub URL the repos say origin is. */
export const URL_ = "https://github.com/acme/widgets.git";
/** owner/name of that repo. */
export const REPO = "acme/widgets";

/**
 * A PR built in a worktree: branch `name` off main, one commit, pushed with
 * its upstream set (as Orca does). Returns the worktree path and the head.
 */
export async function worktreePr(
  r: Repos,
  name: string,
  opts: { upstream?: boolean } = {},
): Promise<{ path: string; head: string; branch: string }> {
  const path = `${r.root}/wt-${name.replace(/\//g, "-")}`;
  await ok(r.main, "worktree", "add", "-q", "-b", name, path, r.trunk);
  await Deno.writeTextFile(`${path}/${name.replace(/\//g, "-")}.txt`, name);
  await ok(path, "add", "-A");
  await ok(path, "commit", "-q", "-m", `work on ${name}`);
  if (opts.upstream === false) await ok(path, "push", "-q", "origin", name);
  else await ok(path, "push", "-q", "-u", "origin", name);
  return { path, head: await ok(path, "rev-parse", "HEAD"), branch: name };
}

/** Merge `branch` into main on origin, as GitHub's merge button does. */
export async function mergeOnOrigin(
  r: Repos,
  branch: string,
  how: "merge" | "squash" = "merge",
): Promise<void> {
  await ok(r.other, "fetch", "-q", "origin");
  await ok(r.other, "checkout", "-q", r.trunk);
  await ok(r.other, "merge", "-q", "--ff-only", `origin/${r.trunk}`);
  if (how === "merge") {
    await ok(
      r.other,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge",
      `origin/${branch}`,
    );
  } else {
    await ok(r.other, "merge", "-q", "--squash", `origin/${branch}`);
    await ok(r.other, "commit", "-q", "-m", `squash ${branch}`);
  }
  await ok(r.other, "push", "-q", "origin", r.trunk);
}

/** A new commit on origin's `branch`, pushed from the other clone. */
export async function pushToOrigin(r: Repos, branch: string): Promise<string> {
  await ok(r.other, "fetch", "-q", "origin");
  await ok(r.other, "checkout", "-q", "-B", branch, `origin/${branch}`);
  await Deno.writeTextFile(`${r.other}/later.txt`, "later");
  await ok(r.other, "add", "-A");
  await ok(r.other, "commit", "-q", "-m", "later");
  await ok(r.other, "push", "-q", "origin", branch);
  const sha = await ok(r.other, "rev-parse", "HEAD");
  await ok(r.other, "checkout", "-q", r.trunk);
  return sha;
}

/** Everything the clean-up could change, to compare before and after. */
export async function snapshot(r: Repos): Promise<string> {
  return [
    await ok(r.main, "for-each-ref", "--format=%(refname) %(objectname)"),
    await ok(r.main, "worktree", "list", "--porcelain"),
    await ok(r.origin, "for-each-ref", "--format=%(refname) %(objectname)"),
    await ok(r.main, "status", "--porcelain"),
  ].join("\n--\n");
}

function okResult(attributes: Record<string, unknown>): RunResult {
  return { ok: true, resources: [{ name: "x", attributes }] };
}

function failed(message: string): RunResult {
  return { ok: false, error: { message } };
}

/** Split a call's arguments into `repoPath` and the method's own. */
function split(call: ModelCall, cwd: string) {
  const { repoPath, ...args } = call.arguments ?? {};
  return { repoPath: typeof repoPath === "string" ? repoPath : cwd, args };
}

async function builtin(
  method: string,
  repoPath: string,
  a: Record<string, unknown>,
): Promise<RunResult> {
  switch (method) {
    case "config": {
      const res = await git(repoPath, "config", String(a.key));
      if (res.code !== 0) return failed(`git config get failed: ${res.stderr}`);
      return okResult({ key: a.key, value: res.stdout });
    }
    case "status": {
      const res = await git(repoPath, "status", "--porcelain");
      if (res.code !== 0) return failed(`git status failed: ${res.stderr}`);
      const lines = res.stdout.split("\n").filter((l) => l.trim());
      return okResult({
        entries: lines.map((l) => ({
          status: l.slice(0, 2),
          path: l.slice(3),
        })),
        clean: lines.length === 0,
      });
    }
    case "is_ancestor": {
      const res = await git(
        repoPath,
        "merge-base",
        "--is-ancestor",
        String(a.ancestor),
        String(a.descendant),
      );
      if (res.code > 1) return failed(`merge-base failed: ${res.stderr}`);
      return okResult({ isAncestor: res.code === 0 });
    }
    case "remote_ref": {
      const res = await git(
        repoPath,
        "ls-remote",
        "--",
        "origin",
        String(a.ref),
      );
      if (res.code !== 0) return failed(`git ls-remote failed: ${res.stderr}`);
      const line = res.stdout.split("\n").find((l) => l.trim());
      if (!line) {
        return failed(
          `ref not found: '${a.ref}' does not exist on remote 'origin'`,
        );
      }
      return okResult({ sha: line.split("\t")[0], ref: line.split("\t")[1] });
    }
    case "remove_worktree": {
      const list = await git(repoPath, "worktree", "list", "--porcelain");
      const paths = [...list.stdout.matchAll(/^worktree (.+)$/gm)].map((m) =>
        m[1]
      );
      if (paths[0] === a.path) {
        return failed("cannot remove the primary checkout");
      }
      if (!paths.includes(String(a.path))) {
        return okResult({ path: a.path, removed: false, alreadyAbsent: true });
      }
      const st = await git(String(a.path), "status", "--porcelain");
      if (st.stdout) {
        return failed(
          "worktree has uncommitted changes — commit or discard before removing",
        );
      }
      const res = await git(repoPath, "worktree", "remove", String(a.path));
      if (res.code !== 0) {
        return failed(`git worktree remove failed: ${res.stderr}`);
      }
      return okResult({ path: a.path, removed: true, alreadyAbsent: false });
    }
    case "branch": {
      if (a.list) {
        // As @swamp/git parses `git branch --list`: only "* " is stripped.
        const res = await git(repoPath, "branch", "--list");
        if (res.code !== 0) {
          return failed(`git branch --list failed: ${res.stderr}`);
        }
        let current: string | undefined;
        const branches = res.stdout.split("\n").filter((l) => l.trim()).map(
          (l) => {
            const t = l.trim();
            if (t.startsWith("* ")) return current = t.slice(2);
            return t;
          },
        );
        return okResult({ current, branches });
      }
      const res = await git(repoPath, "checkout", "-q", String(a.name));
      if (res.code !== 0) return failed(`git checkout failed: ${res.stderr}`);
      return okResult({ current: a.name });
    }
    case "pull": {
      const args = ["pull", ...(a.ffOnly ? ["--ff-only"] : []), "origin"];
      if (a.branch) args.push(String(a.branch));
      const res = await git(repoPath, ...args);
      if (res.code !== 0) {
        return failed(`git pull failed (exit ${res.code}): ${res.stderr}`);
      }
      const raw = `${res.stdout}\n${res.stderr}`;
      return okResult({ alreadyUpToDate: raw.includes("Already up to date") });
    }
  }
  return failed(`the fake has no @swamp/git ${method}`);
}

/** What `fakeSwamp` was asked, in order. */
export type Calls = ModelCall[];

/**
 * A `RunModel` over the repos: `cwd` is the directory swamp runs in, `prs`
 * what GitHub knows. `before` runs before each call, to change things midway.
 */
export function fakeSwamp(
  cwd: string,
  prs: Record<number, FakePr>,
  opts: { before?: (call: ModelCall) => Promise<void>; calls?: Calls } = {},
): RunModel {
  const own = Object.assign({}, ...extension.methods) as Record<
    string,
    { execute: (args: never, ctx: never) => Promise<unknown> }
  >;
  return async (call) => {
    opts.calls?.push(call);
    await opts.before?.(call);
    if (call.modelType === "@webframp/github") {
      const a = call.arguments ?? {};
      if (a.repo !== REPO) return failed(`no repo ${a.repo}`);
      if (call.method === "cleanup_pull_request") {
        // gh's answer, through the real method's code.
        const pr = prs[Number(a.number)];
        const view = await viewPr(String(a.repo), Number(a.number), () => {
          if (!pr) {
            throw new Error(`Could not resolve to a PullRequest ${a.number}`);
          }
          return Promise.resolve({
            number: Number(a.number),
            title: pr.title,
            url: `https://github.com/${REPO}/pull/${a.number}`,
            state: pr.state,
            headRefOid: pr.headRefOid,
            headRefName: pr.headRefName,
          });
        }).catch((e: Error) => e);
        if (view instanceof Error) return failed(view.message);
        return okResult({ pullRequest: view });
      }
      if (call.method === "cleanup_merged_prs") {
        // gh's answer, latest activity first, through the real method's code.
        const rows = Object.entries(prs)
          .filter(([, p]) => p.state === "MERGED")
          .toSorted(([, p], [, q]) =>
            String(q.updatedAt).localeCompare(String(p.updatedAt))
          )
          .map(([n, p]) => ({ number: Number(n), mergedAt: p.mergedAt }));
        return okResult({
          pullRequests: (await listMergedPrs(
            String(a.repo),
            () => Promise.resolve(rows),
          )).pullRequests,
        });
      }
      return failed(`the fake has no @webframp/github ${call.method}`);
    }
    if (call.modelType !== "@swamp/git" || call.name !== "git") {
      return failed(`no model ${call.modelType} ${call.name}`);
    }
    const { repoPath, args } = split(call, cwd);
    const mine = own[call.method];
    if (!mine) return builtin(call.method, repoPath, args);
    const written: Record<string, unknown>[] = [];
    try {
      await mine.execute(args as never, {
        globalArgs: { repoPath },
        logger: { info: () => {} },
        writeResource: (
          _s: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          written.push(data);
          return Promise.resolve({ name });
        },
      } as never);
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
    return okResult(written[0] ?? {});
  };
}
