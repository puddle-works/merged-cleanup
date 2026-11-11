/**
 * Tests for the method this extension adds to `@webframp/github`: the gh
 * command it runs, and how it picks the latest merged PRs from gh's answer.
 * gh itself is faked; the README records a run against real GitHub.
 *
 * Run with: make test
 */
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  extension,
  latestMerged,
  listMergedPrs,
  MERGED_PRS_LOOKED_AT,
  parseGhJson,
  viewPr,
} from "./github_cleanup.ts";

const methods = Object.assign({}, ...extension.methods) as Record<
  string,
  unknown
>;

Deno.test("@webframp/github gets two methods, cleanup_merged_prs and cleanup_pull_request", () => {
  assertEquals(extension.type, "@webframp/github");
  assertEquals(Object.keys(methods), [
    "cleanup_merged_prs",
    "cleanup_pull_request",
  ]);
});

Deno.test("viewPr: asks gh for the PR with its head branch's name, and checks the answer", async () => {
  const asked: string[][] = [];
  const pr = await viewPr("acme/widgets", 22, (args) => {
    asked.push(args);
    return Promise.resolve({
      number: 22,
      title: "Add the thing",
      url: "https://github.com/acme/widgets/pull/22",
      state: "MERGED",
      headRefOid: "a".repeat(40),
      headRefName: "me/feature",
    });
  });
  assertEquals(asked, [[
    "pr",
    "view",
    "22",
    "--repo",
    "acme/widgets",
    "--json",
    "number,title,url,state,headRefOid,headRefName",
  ]]);
  assertEquals(pr.headRefName, "me/feature");
  assertEquals(pr.state, "MERGED");
  await assertRejects(
    () => viewPr("acme/widgets", 22, () => Promise.resolve({ number: 22 })),
    Error,
    "PR #22",
  );
  await assertRejects(
    () => viewPr("acme", 22, () => Promise.resolve({})),
    Error,
    "owner/name",
  );
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
  assertEquals(rows.pullRequests.map((r) => r.number), [8, 9]);
  assertEquals(rows.truncated, false);
});

Deno.test("listMergedPrs: truncated when gh gave as many as it was asked for", async () => {
  const full = Array.from({ length: MERGED_PRS_LOOKED_AT }, (_, i) => ({
    number: i + 1,
    mergedAt: `2026-11-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
  }));
  const out = await listMergedPrs("acme/widgets", () => Promise.resolve(full));
  assertEquals(out.truncated, true);
  assertEquals(out.pullRequests.length, MERGED_PRS_LOOKED_AT);
});

Deno.test("parseGhJson: output that isn't JSON says which command gave it", () => {
  assertEquals(parseGhJson('[{"number":1}]'), [{ number: 1 }]);
  assertThrows(
    () => parseGhJson("<html>rate limited</html>"),
    Error,
    "gh pr list gave output that isn't JSON: <html>rate limited</html>",
  );
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
