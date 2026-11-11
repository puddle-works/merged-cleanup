/**
 * Adds one method to `@webframp/github` that merged-cleanup needs and
 * `@webframp/github` lacks:
 *
 * - `cleanup_merged_prs`: a repo's merged PRs, newest merge first, with when
 *   each was merged. `list_prs` gives no merge time and lists the newest
 *   created first (20 of them), so a PR opened long ago and merged just now
 *   can be missing from it. Read-only.
 *
 * gh is asked for merged PRs by latest activity (`sort:updated-desc`). A merge
 * is activity, so a PR merged just now is near the top; this method then sorts
 * those by merge time. It runs `gh`, so gh must be signed in, as for the rest
 * of `@webframp/github`.
 *
 * The name starts `cleanup_` so it never clashes with another extension's
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

/** The repo's merged PRs, newest merge first. */
export async function listMergedPrs(
  repo: string,
  gh: GhRun,
): Promise<MergedPr[]> {
  const r = Repo.safeParse(repo);
  if (!r.success) throw new Error(`repo must be owner/name, not "${repo}"`);
  return latestMerged(
    await gh([
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
    ]),
  );
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
  if (out.code !== 0) {
    throw new Error(
      `gh pr list failed (exit ${out.code}): ${dec.decode(out.stderr).trim()}`,
    );
  }
  return JSON.parse(dec.decode(out.stdout));
}

interface Context {
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The `@webframp/github` extension: one method and its resource. */
export const extension = {
  type: "@webframp/github",
  resources: {
    cleanupMergedPrs: {
      description: "A repo's merged PRs, newest merge first, with merge times.",
      schema: MergedPrsSchema,
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
        const pullRequests = await listMergedPrs(args.repo, realGh);
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
            listedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
