/**
 * Adds four methods to `@swamp/git` that merged-cleanup needs and
 * `@swamp/git` lacks:
 *
 * - `cleanup_worktree_list`: the repo's worktrees (path, HEAD, branch, flags).
 * - `cleanup_branch_heads`: each local branch and each branch on origin (from
 *   `git ls-remote`, not tracking refs), with its head. Read-only.
 * - `cleanup_delete_branch`: `git branch -d` (never `-D`); a branch already
 *   gone is "already absent", a refusal (or a repo it can't read) throws with
 *   git's message.
 * - `cleanup_delete_remote_branch`: deletes a branch on origin with
 *   `--force-with-lease` on the head it is expected at, so a branch that moved
 *   is never deleted; a branch already gone is "already absent".
 *
 * The names start `cleanup_` so they never clash with another extension's
 * methods on `@swamp/git` (puddlerouter adds `worktree_list`).
 *
 * @module
 */
import { z } from "npm:zod@4";

/** One worktree, as `git worktree list --porcelain` gives it. */
export const WorktreeSchema = z.object({
  path: z.string(),
  /** The commit checked out; empty for a bare repo. */
  head: z.string(),
  /** The branch without `refs/heads/`; empty when detached or bare. */
  branch: z.string(),
  /** True for the first entry: the main checkout, not a linked worktree. */
  primary: z.boolean(),
  detached: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
});
/** One worktree. */
export type Worktree = z.infer<typeof WorktreeSchema>;

/** The worktrees in `git worktree list --porcelain` output, in its order. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l !== "");
    const path = lines.find((l) => l.startsWith("worktree "));
    if (!path) continue;
    const value = (key: string) =>
      lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
    const flag = (key: string) =>
      lines.some((l) => l === key || l.startsWith(`${key} `));
    out.push({
      path: path.slice("worktree ".length),
      head: value("HEAD"),
      branch: value("branch").replace(/^refs\/heads\//, ""),
      primary: out.length === 0,
      detached: flag("detached"),
      bare: flag("bare"),
      locked: flag("locked"),
      prunable: flag("prunable"),
    });
  }
  return out;
}

const WorktreeListSchema = z.object({
  repoPath: z.string(),
  worktrees: z.array(WorktreeSchema),
  listedAt: z.iso.datetime(),
});

const BranchHeadSchema = z.object({ name: z.string(), head: z.string() });

const BranchHeadsSchema = z.object({
  repoPath: z.string(),
  /** Local branches, without `refs/heads/`. */
  localBranches: z.array(BranchHeadSchema),
  /** origin's branches as origin has them now. */
  originBranches: z.array(BranchHeadSchema),
  listedAt: z.iso.datetime(),
});

/** `sha<TAB>refs/heads/name` lines as name and head. */
function heads(out: string, shaFirst: boolean) {
  return out.split("\n").filter((l) => l.includes("\t")).map((l) => {
    const [a, b] = l.split("\t");
    const [ref, head] = shaFirst ? [b, a] : [a, b];
    return { name: ref.replace(/^refs\/heads\//, ""), head };
  });
}

const BranchDeleteSchema = z.object({
  repoPath: z.string(),
  branch: z.string(),
  /** True when this call deleted it. */
  deleted: z.boolean(),
  /** True when there was no such branch to delete. */
  alreadyAbsent: z.boolean(),
  deletedAt: z.iso.datetime(),
});

const RemoteBranchDeleteSchema = BranchDeleteSchema.extend({
  remote: z.literal("origin"),
  /** The head origin's branch had to be at for the delete to go through. */
  expect: z.string(),
});

/**
 * A local branch name that is safe to hand to git: no option-like start, no
 * `..`, and never main or master.
 */
const BranchName = z.string()
  .regex(/^[A-Za-z0-9._/-]+$/, "branch has characters git branch names avoid")
  .refine((b) => !b.startsWith("-"), "branch may not start with -")
  .refine((b) => !b.includes(".."), "branch may not contain ..")
  .refine((b) => b !== "main" && b !== "master", "main and master are kept");

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("git", {
    args,
    cwd,
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

interface Context {
  globalArgs: Record<string, unknown>;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

const repoPathOf = (ctx: Context) =>
  typeof ctx.globalArgs.repoPath === "string" ? ctx.globalArgs.repoPath : ".";

/** The `@swamp/git` extension: the four methods and their resources. */
export const extension = {
  type: "@swamp/git",
  resources: {
    cleanupWorktrees: {
      description: "The repo's worktrees: path, HEAD, branch and flags.",
      schema: WorktreeListSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
    cleanupBranchHeads: {
      description:
        "Each local branch and each branch on origin, with its head.",
      schema: BranchHeadsSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
    cleanupBranchDelete: {
      description:
        "A local branch deleted with git branch -d, or already gone.",
      schema: BranchDeleteSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
    cleanupRemoteBranchDelete: {
      description:
        "A branch deleted on origin with a lease on its expected head, or already gone.",
      schema: RemoteBranchDeleteSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    cleanup_worktree_list: {
      description:
        "List the repo's worktrees (read-only, via git worktree list --porcelain).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const repoPath = repoPathOf(ctx);
        ctx.logger.info("Listing worktrees in {repoPath}", { repoPath });
        const res = await git(["worktree", "list", "--porcelain"], repoPath);
        if (res.code !== 0) {
          throw new Error(
            `git worktree list failed (exit ${res.code}): ${res.stderr}`,
          );
        }
        const worktrees = parseWorktreeList(res.stdout);
        ctx.logger.info("Found {count} worktrees", { count: worktrees.length });
        const handle = await ctx.writeResource(
          "cleanupWorktrees",
          "cleanup-worktrees",
          { repoPath, worktrees, listedAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
    cleanup_branch_heads: {
      description:
        "List each local branch and each branch on origin with its head (read-only: git for-each-ref and git ls-remote --heads origin).",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const repoPath = repoPathOf(ctx);
        ctx.logger.info("Listing branches in {repoPath} and on origin", {
          repoPath,
        });
        const local = await git(
          ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"],
          repoPath,
        );
        if (local.code !== 0) {
          throw new Error(
            `git for-each-ref failed (exit ${local.code}): ${local.stderr}`,
          );
        }
        const remote = await git(
          ["ls-remote", "--heads", "--", "origin"],
          repoPath,
        );
        if (remote.code !== 0) {
          throw new Error(
            `git ls-remote failed (exit ${remote.code}): ${remote.stderr}`,
          );
        }
        const data = {
          repoPath,
          localBranches: heads(local.stdout, false),
          originBranches: heads(remote.stdout, true),
          listedAt: new Date().toISOString(),
        };
        ctx.logger.info("Found {local} local branches and {origin} on origin", {
          local: data.localBranches.length,
          origin: data.originBranches.length,
        });
        const handle = await ctx.writeResource(
          "cleanupBranchHeads",
          "cleanup-branch-heads",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
    cleanup_delete_branch: {
      description:
        "Delete a local branch with git branch -d (never -D). Already gone is reported, not an error; git refusing (not merged) is an error.",
      arguments: z.object({ branch: BranchName }),
      execute: async (args: { branch: string }, ctx: Context) => {
        const branch = BranchName.parse(args.branch);
        const repoPath = repoPathOf(ctx);
        const ref = `refs/heads/${branch}`;
        ctx.logger.info("Deleting branch {branch}", { branch });
        // rev-parse --verify --quiet exits 1 for a missing ref; anything else
        // (128 for a folder that is no repo) means the repo can't be read.
        const probe = await git(
          ["rev-parse", "--verify", "--quiet", ref],
          repoPath,
        );
        if (probe.code > 1) {
          throw new Error(
            `could not read branch ${branch} (exit ${probe.code}): ${probe.stderr}`,
          );
        }
        const exists = probe.code === 0;
        if (exists) {
          const res = await git(["branch", "-d", "--", branch], repoPath);
          if (res.code !== 0) {
            throw new Error(res.stderr || `git branch -d exited ${res.code}`);
          }
        }
        ctx.logger.info("Branch {branch}: {what}", {
          branch,
          what: exists ? "deleted" : "already gone",
        });
        const handle = await ctx.writeResource(
          "cleanupBranchDelete",
          `cleanup-branch-${branch.replace(/[^\w.-]+/g, "-")}`,
          {
            repoPath,
            branch,
            deleted: exists,
            alreadyAbsent: !exists,
            deletedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    cleanup_delete_remote_branch: {
      description:
        "Delete a branch on origin only while it is at the expected commit (git push --force-with-lease=<branch>:<expect> --delete). Already gone is reported; a branch that moved is an error.",
      arguments: z.object({
        branch: BranchName,
        expect: z.string().regex(
          /^[0-9a-f]{40}$/,
          "expect is a full commit id",
        ),
      }),
      execute: async (
        args: { branch: string; expect: string },
        ctx: Context,
      ) => {
        const branch = BranchName.parse(args.branch);
        const expect = z.string().regex(
          /^[0-9a-f]{40}$/,
          "expect is a full commit id",
        )
          .parse(args.expect);
        const repoPath = repoPathOf(ctx);
        const ref = `refs/heads/${branch}`;
        ctx.logger.info("Deleting origin/{branch} at {expect}", {
          branch,
          expect,
        });
        const listed = await git(["ls-remote", "--", "origin", ref], repoPath);
        if (listed.code !== 0) {
          throw new Error(`git ls-remote failed: ${listed.stderr}`);
        }
        const exists = listed.stdout !== "";
        if (exists) {
          const res = await git(
            [
              "push",
              `--force-with-lease=${ref}:${expect}`,
              "origin",
              "--delete",
              ref,
            ],
            repoPath,
          );
          if (res.code !== 0) {
            throw new Error(
              res.stderr || `git push --delete exited ${res.code}`,
            );
          }
        }
        ctx.logger.info("origin/{branch}: {what}", {
          branch,
          what: exists ? "deleted" : "already gone",
        });
        const handle = await ctx.writeResource(
          "cleanupRemoteBranchDelete",
          `cleanup-remote-branch-${branch.replace(/[^\w.-]+/g, "-")}`,
          {
            repoPath,
            branch,
            remote: "origin",
            expect,
            deleted: exists,
            alreadyAbsent: !exists,
            deletedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
