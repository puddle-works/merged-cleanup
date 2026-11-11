/**
 * Tests for the method this extension adds to `@webframp/github`: the gh
 * command it runs, and how it picks the latest merged PRs from gh's answer.
 * gh itself is faked; the README records a run against real GitHub.
 *
 * Run with: make test
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  extension,
  latestMerged,
  listMergedPrs,
  MERGED_PRS_LOOKED_AT,
} from "./github_cleanup.ts";

const methods = Object.assign({}, ...extension.methods) as Record<
  string,
  unknown
>;

Deno.test("@webframp/github gets one method, cleanup_merged_prs", () => {
  assertEquals(extension.type, "@webframp/github");
  assertEquals(Object.keys(methods), ["cleanup_merged_prs"]);
});

Deno.test("latestMerged: newest merge first, whatever gh's order; unmerged rows dropped", () => {
  assertEquals(
    latestMerged([
      { number: 1, mergedAt: "2026-10-01T00:00:00Z" },
      { number: 2, mergedAt: "2026-11-04T00:00:00Z" },
      { number: 3, mergedAt: null },
      { number: 4, mergedAt: "2026-11-02T00:00:00Z" },
      { number: "5", mergedAt: "2026-11-05T00:00:00Z" },
    ]),
    [
      { number: 2, mergedAt: "2026-11-04T00:00:00Z" },
      { number: 4, mergedAt: "2026-11-02T00:00:00Z" },
      { number: 1, mergedAt: "2026-10-01T00:00:00Z" },
    ],
  );
  assertEquals(latestMerged("not a list"), []);
});

Deno.test("listMergedPrs: asks gh for merged PRs by latest activity, then sorts by merge time", async () => {
  const asked: string[][] = [];
  const rows = await listMergedPrs("acme/widgets", (args) => {
    asked.push(args);
    return Promise.resolve([
      { number: 9, mergedAt: "2026-10-01T00:00:00Z" },
      { number: 8, mergedAt: "2026-11-03T00:00:00Z" },
    ]);
  });
  assertEquals(asked, [[
    "pr",
    "list",
    "--repo",
    "acme/widgets",
    "--state",
    "merged",
    "--search",
    "sort:updated-desc",
    "--json",
    "number,mergedAt",
    "--limit",
    String(MERGED_PRS_LOOKED_AT),
  ]]);
  assertEquals(rows.map((r) => r.number), [8, 9]);
});

Deno.test("listMergedPrs: refuses a repo that isn't owner/name", async () => {
  for (const repo of ["acme", "--repo=x/y", "acme/widgets/extra", "a b/c"]) {
    await assertRejects(
      () => listMergedPrs(repo, () => Promise.resolve([])),
      Error,
      "owner/name",
    );
  }
});
