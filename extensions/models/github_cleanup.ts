/**
 * Adds two methods to `@webframp/github` that merged-cleanup needs and
 * `@webframp/github` lacks:
 *
 * - `cleanup_merged_prs`: a repo's merged PRs, newest merge first, with when
 *   each was merged. `list_prs` gives no merge time and lists the newest
 *   created first (20 of them), so a PR opened long ago and merged just now
 *   can be missing from it. Read-only.
 * - `cleanup_pull_request`: one PR's state, head commit and head branch name.
 *   `get_pull_request_context` gives no branch name, and only the PR's own
 *   branch may be cleaned up, not another one at the same commit. Read-only.
 *
 * gh is asked for merged PRs by latest activity (`sort:updated-desc`). A merge
 * is activity, so a PR merged just now is near the top; this method then sorts
 * those by merge time. It runs `gh`, so gh must be signed in, as for the rest
 * of `@webframp/github`.
 *
 * The names start `cleanup_` so they never clash with another extension's
 * methods on `@webframp/github`.
 *
 * @module
 */
import { z } from "npm:zod@4";

/**
 * How many merged PRs, by latest activity, are sorted by merge time. A PR is
 * missed only when more than this many merged PRs had activity after it was
 * merged.
 */
export const MERGED_PRS_LOOKED_AT = 30;

const MergedPrSchema = z.object({
  number: z.number().int(),
  mergedAt: z.iso.datetime(),
});
/** One merged PR and when it was merged. */
export type MergedPr = z.infer<typeof MergedPrSchema>;

const MergedPrsSchema = z.object({
  repo: z.string(),
  /** Newest merge first. */
  pullRequests: z.array(MergedPrSchema),
  /**
   * True when gh gave as many PRs as it was asked for, so older merges may
   * have been left out.
   */
  truncated: z.boolean(),
  listedAt: z.iso.datetime(),
});

const Repo = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
  "repo must be owner/name",
);

/** gh's rows as merged PRs, newest merge first; rows with no merge dropped. */
export function latestMerged(rows: unknown): MergedPr[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => MergedPrSchema.safeParse(r))
    .flatMap((r) => (r.success ? [r.data] : []))
    .toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

/** Runs gh with these arguments and gives its parsed JSON output. */
export type GhRun = (args: string[]) => Promise<unknown>;

/**
 * The repo's merged PRs, newest merge first, and whether gh gave as many as
 * it was asked for (so older merges may be missing).
 */
export async function listMergedPrs(
  repo: string,
  gh: GhRun,
): Promise<{ pullRequests: MergedPr[]; truncated: boolean }> {
  const r = Repo.safeParse(repo);
  if (!r.success) throw new Error(`repo must be owner/name, not "${repo}"`);
  const rows = await gh([
    "pr",
    "list",
    "--repo",
    r.data,
    "--state",
    "merged",
    "--search",
    "sort:updated-desc",
    "--json",
    "number,mergedAt",
    "--limit",
    String(MERGED_PRS_LOOKED_AT),
  ]);
  return {
    pullRequests: latestMerged(rows),
    truncated: Array.isArray(rows) && rows.length >= MERGED_PRS_LOOKED_AT,
  };
}

const PullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["MERGED", "OPEN", "CLOSED"]),
  headRefOid: z.string(),
  /** The PR's own branch, without `refs/heads/`. */
  headRefName: z.string(),
});
/** One PR as cleanup needs it. */
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** One PR's state, head commit and head branch name. */
export async function viewPr(
  repo: string,
  number: number,
  gh: GhRun,
): Promise<PullRequest> {
  const r = Repo.safeParse(repo);
  if (!r.success) throw new Error(`repo must be owner/name, not "${repo}"`);
  const n = z.number().int().positive().parse(number);
  const out = PullRequestSchema.safeParse(
    await gh([
      "pr",
      "view",
      String(n),
      "--repo",
      r.data,
      "--json",
      "number,title,url,state,headRefOid,headRefName",
    ]),
  );
  if (!out.success) {
    throw new Error(`gh gave PR #${n} without its state, head or branch`);
  }
  return out.data;
}

/** gh's stdout as JSON, or an error that says which command gave it. */
export function parseGhJson(stdout: string, command = "gh pr list"): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} gave output that isn't JSON: ${stdout.trim()}`);
  }
}

async function realGh(args: string[]): Promise<unknown> {
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("gh", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const command = `gh ${args.slice(0, 2).join(" ")}`;
  if (out.code !== 0) {
    throw new Error(
      `${command} failed (exit ${out.code}): ${dec.decode(out.stderr).trim()}`,
    );
  }
  return parseGhJson(dec.decode(out.stdout), command);
}

interface Context {
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The `@webframp/github` extension: two methods and their resources. */
export const extension = {
  type: "@webframp/github",
  resources: {
    cleanupMergedPrs: {
      description: "A repo's merged PRs, newest merge first, with merge times.",
      schema: MergedPrsSchema,
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
    cleanupPullRequest: {
      description: "One PR's state, head commit and head branch name.",
      schema: z.object({
        repo: z.string(),
        pullRequest: PullRequestSchema,
        viewedAt: z.iso.datetime(),
      }),
      lifetime: "ephemeral" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    cleanup_merged_prs: {
      description:
        "List a repo's merged PRs, newest merge first, with when each was merged (read-only: gh pr list --state merged).",
      arguments: z.object({ repo: Repo }),
      execute: async (args: { repo: string }, ctx: Context) => {
        ctx.logger.info("Listing merged PRs in {repo}", { repo: args.repo });
        const { pullRequests, truncated } = await listMergedPrs(
          args.repo,
          realGh,
        );
        ctx.logger.info("Found {count} merged PRs in {repo}", {
          count: pullRequests.length,
          repo: args.repo,
        });
        const handle = await ctx.writeResource(
          "cleanupMergedPrs",
          `cleanup-merged-prs-${args.repo.replace(/[^\w.-]+/g, "-")}`,
          {
            repo: args.repo,
            pullRequests,
            truncated,
            listedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    cleanup_pull_request: {
      description:
        "One PR's state, head commit and head branch name (read-only: gh pr view).",
      arguments: z.object({ repo: Repo, number: z.number().int().positive() }),
      execute: async (args: { repo: string; number: number }, ctx: Context) => {
        ctx.logger.info("Looking up #{number} in {repo}", args);
        const pullRequest = await viewPr(args.repo, args.number, realGh);
        ctx.logger.info("#{number} is {state} on {branch}", {
          number: args.number,
          state: pullRequest.state,
          branch: pullRequest.headRefName,
        });
        const handle = await ctx.writeResource(
          "cleanupPullRequest",
          `cleanup-pr-${args.repo.replace(/[^\w.-]+/g, "-")}-${args.number}`,
          { repo: args.repo, pullRequest, viewedAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
