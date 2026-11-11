/**
 * Tests for check and clean, one or more per acceptance criterion of the
 * outcome spec (spec/outcome-spec.v2.json), on real git repos with GitHub
 * faked.
 *
 * Run with: make test
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  act,
  check,
  clean,
  inspect,
  type Item,
  ItemSchema,
  prNumbers,
  summarise,
} from "./cleanup.ts";
import {
  type Calls,
  type FakePr,
  fakeSwamp,
  git,
  mergeOnOrigin,
  ok,
  pushToOrigin,
  type Repos,
  repos,
  snapshot,
  worktreePr,
} from "./fixture_test.ts";

const merged = (
  pr: { head: string; branch: string },
  mergedAt = "2026-11-10T10:00:00Z",
): FakePr => ({
  title: "Add the thing",
  state: "MERGED",
  headRefOid: pr.head,
  headRefName: pr.branch,
  mergedAt,
  updatedAt: mergedAt,
});

async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ))
    .code === 0;
}

async function worktreeExists(r: Repos, path: string): Promise<boolean> {
  return (await ok(r.main, "worktree", "list", "--porcelain")).includes(
    `worktree ${path}\n`,
  );
}

function statuses(item: Item): Record<string, string> {
  return Object.fromEntries(item.steps.map((s) => [s.step, s.status]));
}

/** A merged PR 22 built in a clean worktree at its head, main behind origin. */
async function mergedPr(r: Repos, how: "merge" | "squash" = "merge") {
  const wt = await worktreePr(r, "me/feature");
  await mergeOnOrigin(r, "me/feature", how);
  return wt;
}

// ---- prNumbers --------------------------------------------------------------

Deno.test("prNumbers: pr and prs together, digits only, at most 5, none named is empty", () => {
  assertEquals(prNumbers(0, ""), []);
  assertEquals(prNumbers(22, ""), [22]);
  assertEquals(prNumbers(0, "3, 4,5"), [3, 4, 5]);
  assertEquals(prNumbers(22, "23,24"), [22, 23, 24]);
  assertEquals(prNumbers(22, "22"), [22]);
  assertEquals(prNumbers(1, "2,3,4,5"), [1, 2, 3, 4, 5]);
  for (
    const [pr, prs] of [
      [1, "2,3,4,5,6"],
      [-1, ""],
      [0, "1;2"],
      [0, "x"],
      [0, "1,,2"],
      [0, "0"],
      [0, "1.5"],
    ] as const
  ) {
    assertThrows(() => prNumbers(pr, prs), Error, undefined, `${pr} ${prs}`);
  }
});

// ---- AC1 --------------------------------------------------------------------

Deno.test("AC1: check on a merged PR at its worktree's head says clean and changes nothing", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const before = await snapshot(r);
  const items = await check(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(items.length, 1);
  assertEquals(items[0].verdict, "clean");
  assertEquals(items[0].worktree, wt.path);
  assertEquals(items[0].branch, "me/feature");
  assertEquals(items[0].steps, []);
  assertMatch(items[0].reason, /no uncommitted changes/);
  assertMatch(items[0].line, /^#22 \(Add the thing\) clean: /);
  assertEquals(await snapshot(r), before);
});

Deno.test("AC1: check works from inside the PR's own worktree too", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const items = await check(
    { pr: 22, prs: "" },
    fakeSwamp(wt.path, { 22: merged(wt) }),
  );
  assertEquals(items[0].verdict, "clean");
});

// ---- AC2 --------------------------------------------------------------------

Deno.test("AC2: clean removes the worktree, both branches and fast-forwards main, all four steps done", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(items.length, 1);
  assertEquals(items[0].steps.map((s) => [s.step, s.status]), [
    ["remove worktree", "done"],
    ["delete local branch", "done"],
    ["delete origin branch", "done"],
    ["fast-forward main", "done"],
  ]);
  assertEquals(await worktreeExists(r, wt.path), false);
  assertEquals(await branchExists(r.main, "me/feature"), false);
  assertEquals(await branchExists(r.origin, "me/feature"), false);
  assertEquals(
    await ok(r.main, "rev-parse", "main"),
    await ok(r.origin, "rev-parse", "main"),
  );
  assertEquals(
    items[0].line,
    "#22 (Add the thing): worktree removed, local branch deleted, origin branch deleted, main fast-forwarded",
  );
  assertEquals(summarise(items, "clean"), "#22 cleaned up");
});

Deno.test("AC2: a squash-merged branch that tracks origin is deleted with -d", async () => {
  await using r = await repos();
  const wt = await mergedPr(r, "squash");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(statuses(items[0])["delete local branch"], "done");
  assertEquals(await branchExists(r.main, "me/feature"), false);
});

// ---- AC3 --------------------------------------------------------------------

async function cleanChangesNothing(
  r: Repos,
  prs: Record<number, FakePr>,
  verdict: string,
  why: RegExp,
) {
  const before = await snapshot(r);
  const items = await clean({ pr: 22, prs: "" }, fakeSwamp(r.main, prs));
  assertEquals(items.length, 1);
  assertEquals(items[0].verdict, verdict);
  assertEquals(items[0].steps, []);
  assertMatch(items[0].reason, why);
  assertMatch(items[0].line, /left as is/);
  assertEquals(await snapshot(r), before);
}

Deno.test("AC3: clean on a dirty worktree changes nothing and says why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await Deno.writeTextFile(`${wt.path}/wip.txt`, "wip");
  await cleanChangesNothing(
    r,
    { 22: merged(wt) },
    "dirty",
    /uncommitted changes/,
  );
});

Deno.test("AC3: clean on a locked worktree changes nothing and says why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "lock", wt.path);
  await cleanChangesNothing(r, { 22: merged(wt) }, "locked", /locked/);
});

Deno.test("AC3: clean on a worktree with commits after the head changes nothing and says why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await Deno.writeTextFile(`${wt.path}/more.txt`, "more");
  await ok(wt.path, "add", "-A");
  await ok(wt.path, "commit", "-q", "-m", "more");
  await cleanChangesNothing(
    r,
    { 22: merged(wt) },
    "ahead",
    /commits after/,
  );
});

Deno.test("AC3: clean on a PR with no worktree and no branch at its head changes nothing and says why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "-D", "me/feature");
  await ok(r.other, "push", "-q", "origin", "--delete", "me/feature");
  await cleanChangesNothing(
    r,
    { 22: merged(wt) },
    "absent",
    /no worktree/i,
  );
});

Deno.test("AC3: clean on an open or closed PR changes nothing and says why", async () => {
  for (const state of ["OPEN", "CLOSED"] as const) {
    await using r = await repos();
    const wt = await worktreePr(r, "me/feature");
    await cleanChangesNothing(
      r,
      {
        22: { title: "t", state, headRefOid: wt.head, headRefName: wt.branch },
      },
      state.toLowerCase(),
      /not merged/,
    );
  }
});

Deno.test("AC3: clean on a PR GitHub can't find changes nothing and says why", async () => {
  await using r = await repos();
  await worktreePr(r, "me/feature");
  await cleanChangesNothing(r, {}, "error", /could not be checked/);
});

Deno.test("a PR GitHub gives no state for is an error, not closed", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  const noState = { title: "t", headRefOid: wt.head } as unknown as FakePr;
  await cleanChangesNothing(
    r,
    { 22: noState },
    "error",
    /without its state/,
  );
});

// ---- AC4 --------------------------------------------------------------------

Deno.test("AC4: a commit in the worktree after check: not removed, the PR's steps skipped with why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const found = await inspect([22], run);
  assertEquals(found.findings[0].verdict, "clean");
  await Deno.writeTextFile(`${wt.path}/more.txt`, "more");
  await ok(wt.path, "add", "-A");
  await ok(wt.path, "commit", "-q", "-m", "more");
  const items = await act(found, run);
  assertEquals(await worktreeExists(r, wt.path), true);
  assertEquals(await branchExists(r.main, "me/feature"), true);
  assertEquals(await branchExists(r.origin, "me/feature"), true);
  assertEquals(
    new Set(items[0].steps.map((s) => s.status)),
    new Set(["skipped"]),
  );
  assertEquals(items[0].steps.length, 4);
  assertMatch(items[0].steps[0].detail, /new commit/);
  assertMatch(items[0].line, /left as is: .*new commit/);
});

Deno.test("AC4: an uncommitted change in the worktree after check: not removed, steps skipped with why", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const found = await inspect([22], run);
  await Deno.writeTextFile(`${wt.path}/wip.txt`, "wip");
  const items = await act(found, run);
  assertEquals(await worktreeExists(r, wt.path), true);
  assertEquals(await branchExists(r.main, "me/feature"), true);
  assert(items[0].steps.every((s) => s.status === "skipped"));
  assertMatch(items[0].steps[0].detail, /uncommitted changes/);
});

Deno.test("AC4: the main checkout of a primary PR changed after check: not switched, steps skipped", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "checkout", "-q", "me/feature");
  await mergeOnOrigin(r, "me/feature");
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const found = await inspect([22], run);
  assertEquals(found.findings[0].verdict, "primary");
  await Deno.writeTextFile(`${r.main}/wip.txt`, "wip");
  const items = await act(found, run);
  assertEquals(await ok(r.main, "branch", "--show-current"), "me/feature");
  assert(items[0].steps.every((s) => s.status === "skipped"));
  assertMatch(items[0].steps[0].detail, /uncommitted changes/);
});

// ---- AC5 --------------------------------------------------------------------

Deno.test("AC5: origin's branch moved past the head: not deleted, and clean says so", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const later = await pushToOrigin(r, "me/feature");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  const s = items[0].steps.find((s) => s.step === "delete origin branch")!;
  assertEquals(s.status, "skipped");
  assertMatch(s.detail, /moved/);
  assertEquals(await ok(r.origin, "rev-parse", "refs/heads/me/feature"), later);
  assertEquals(statuses(items[0])["remove worktree"], "done");
  assertMatch(items[0].line, /origin branch not deleted \(.*moved/);
  assertEquals(summarise(items, "clean"), "#22 partly cleaned up");
});

// ---- AC6 --------------------------------------------------------------------

Deno.test("AC6: worktree and local branch already gone when clean acts: already done, the rest carry on", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const found = await inspect([22], run);
  // Orca cleans up late, between check and clean.
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "-D", "me/feature");
  const items = await act(found, run);
  assertEquals(statuses(items[0]), {
    "remove worktree": "already done",
    "delete local branch": "already done",
    "delete origin branch": "done",
    "fast-forward main": "done",
  });
  assertEquals(await branchExists(r.origin, "me/feature"), false);
  assertEquals(summarise(items, "clean"), "#22 cleaned up");
});

Deno.test("AC6: worktree and local branch removed before check (by Orca): origin's branch is still deleted", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "-D", "me/feature");
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const [checked] = await check({ pr: 22, prs: "" }, run);
  assertEquals(checked.verdict, "clean");
  assertEquals(checked.worktree, "");
  assertEquals(checked.branch, "me/feature");
  assertMatch(checked.reason, /worktree is already gone/);
  const items = await clean({ pr: 22, prs: "" }, run);
  assertEquals(statuses(items[0]), {
    "remove worktree": "already done",
    "delete local branch": "already done",
    "delete origin branch": "done",
    "fast-forward main": "done",
  });
  assertEquals(await branchExists(r.origin, "me/feature"), false);
  assertEquals(summarise(items, "clean"), "#22 cleaned up");
});

Deno.test("AC6: worktree removed before check, local branch left: both branches deleted", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(statuses(items[0]), {
    "remove worktree": "already done",
    "delete local branch": "done",
    "delete origin branch": "done",
    "fast-forward main": "done",
  });
  assertEquals(await branchExists(r.main, "me/feature"), false);
  assertEquals(await branchExists(r.origin, "me/feature"), false);
});

Deno.test("only the PR's own branch: another branch at its head, the PR's gone, is never deleted", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "-D", "me/feature");
  await ok(r.other, "push", "-q", "origin", "--delete", "me/feature");
  // New work started from the PR's head, before its first commit.
  await ok(r.main, "branch", "-q", "me/next", wt.head);
  await ok(r.main, "push", "-q", "-u", "origin", "me/next");
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const [checked] = await check({ pr: 22, prs: "" }, run);
  assertEquals(checked.verdict, "absent");
  assertEquals(checked.branch, "");
  const before = await snapshot(r);
  const [item] = await clean({ pr: 22, prs: "" }, run);
  assertEquals(item.steps, []);
  assertEquals(await snapshot(r), before);
  assertEquals(await branchExists(r.main, "me/next"), true);
  assertEquals(await branchExists(r.origin, "me/next"), true);
});

Deno.test("only the PR's own branch: a worktree on another branch at its head is never removed", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "-D", "me/feature");
  await ok(r.other, "push", "-q", "origin", "--delete", "me/feature");
  // A stacked PR's worktree, started at the PR's head.
  const next = `${r.root}/wt-me-next`;
  await ok(r.main, "worktree", "add", "-q", "-b", "me/next", next, wt.head);
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const [checked] = await check({ pr: 22, prs: "" }, run);
  assert(checked.verdict !== "clean", checked.reason);
  assert(checked.worktree !== next, checked.reason);
  const before = await snapshot(r);
  const [item] = await clean({ pr: 22, prs: "" }, run);
  assertEquals(item.steps, []);
  assertEquals(await snapshot(r), before);
  assertEquals(await worktreeExists(r, next), true);
  // With none named, it isn't picked as the latest PR's worktree either.
  const latest = await check({ pr: 0, prs: "" }, run);
  assertEquals(latest, []);
});

Deno.test("clean run again after origin's delete failed finishes it, the rest already done", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const real = fakeSwamp(r.main, { 22: merged(wt) });
  const first = await clean(
    { pr: 22, prs: "" },
    (call) =>
      call.method === "cleanup_delete_remote_branch"
        ? Promise.resolve({
          ok: false,
          error: {
            message: "fatal: unable to access origin: Could not resolve host",
          },
        })
        : real(call),
  );
  assertEquals(statuses(first[0])["delete origin branch"], "failed");
  assertEquals(await branchExists(r.origin, "me/feature"), true);
  const again = await clean({ pr: 22, prs: "" }, real);
  assertEquals(statuses(again[0]), {
    "remove worktree": "already done",
    "delete local branch": "already done",
    "delete origin branch": "done",
    "fast-forward main": "already done",
  });
  assertEquals(await branchExists(r.origin, "me/feature"), false);
});

Deno.test("worktree gone but the local branch has commits after the head: ahead, nothing touched", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await Deno.writeTextFile(`${wt.path}/more.txt`, "more");
  await ok(wt.path, "add", "-A");
  await ok(wt.path, "commit", "-q", "-m", "more work");
  await ok(r.main, "worktree", "remove", wt.path);
  await cleanChangesNothing(
    r,
    { 22: merged(wt) },
    "ahead",
    /me\/feature.*commits after/,
  );
});

Deno.test("a worktree on the PR's branch but behind its head, origin at the head: absent, nothing touched", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(wt.path, "reset", "-q", "--hard", "HEAD~1");
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const [checked] = await check({ pr: 22, prs: "" }, run);
  assertEquals([checked.verdict, checked.worktree], ["absent", wt.path]);
  assertMatch(checked.reason, /behind #22's head/);
  await cleanChangesNothing(
    r,
    { 22: merged(wt) },
    "absent",
    /behind #22's head/,
  );
  assertEquals(await branchExists(r.origin, "me/feature"), true);
});

Deno.test("items carry only the fields ItemSchema names", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const run = fakeSwamp(r.main, { 22: merged(wt), 23: merged(wt) });
  for (const i of await check({ pr: 22, prs: "" }, run)) {
    ItemSchema.strict().parse(i);
  }
  await ok(r.main, "worktree", "remove", wt.path);
  for (const i of await clean({ pr: 22, prs: "" }, run)) {
    ItemSchema.strict().parse(i);
  }
});

Deno.test("worktree gone and another branch at the head too: only the PR's own branch is deleted", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "me/next", "me/feature");
  const run = fakeSwamp(r.main, { 22: merged(wt) });
  const [checked] = await check({ pr: 22, prs: "" }, run);
  assertEquals([checked.verdict, checked.branch], ["clean", "me/feature"]);
  await clean({ pr: 22, prs: "" }, run);
  assertEquals(await branchExists(r.main, "me/feature"), false);
  assertEquals(await branchExists(r.origin, "me/feature"), false);
  assertEquals(await branchExists(r.main, "me/next"), true);
});

Deno.test("AC6: origin's branch already gone: already done", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await ok(r.other, "push", "-q", "origin", "--delete", "me/feature");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(statuses(items[0])["delete origin branch"], "already done");
  assertEquals(statuses(items[0])["remove worktree"], "done");
});

Deno.test("a squash-merged branch with no upstream: -d refuses, reported failed, never forced", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature", { upstream: false });
  await mergeOnOrigin(r, "me/feature", "squash");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  const s = items[0].steps.find((s) => s.step === "delete local branch")!;
  assertEquals(s.status, "failed");
  assertMatch(s.detail, /not fully merged/);
  assertEquals(await ok(r.main, "rev-parse", "refs/heads/me/feature"), wt.head);
  // The origin delete is leased on the PR's head, so it still runs.
  assertEquals(statuses(items[0])["delete origin branch"], "done");
});

// ---- AC7 --------------------------------------------------------------------

Deno.test("AC7: main checkout has uncommitted changes: left untouched, pull skipped, other steps run", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await Deno.writeTextFile(`${r.main}/README.md`, "edited\n");
  const mainBefore = await ok(r.main, "rev-parse", "main");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  const s = items[0].steps.find((s) => s.step === "fast-forward main")!;
  assertEquals(s.status, "skipped");
  assertMatch(s.detail, /uncommitted changes/);
  assertEquals(await ok(r.main, "rev-parse", "main"), mainBefore);
  assertEquals(await Deno.readTextFile(`${r.main}/README.md`), "edited\n");
  assertEquals(statuses(items[0])["remove worktree"], "done");
  assertEquals(statuses(items[0])["delete origin branch"], "done");
});

Deno.test("AC7: main can't fast-forward: left untouched, pull skipped, other steps run", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  await Deno.writeTextFile(`${r.main}/local.txt`, "local");
  await ok(r.main, "add", "-A");
  await ok(r.main, "commit", "-q", "-m", "local only");
  const mainBefore = await ok(r.main, "rev-parse", "main");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  const s = items[0].steps.find((s) => s.step === "fast-forward main")!;
  assertEquals(s.status, "skipped");
  assertMatch(s.detail, /fast-forward/);
  assertEquals(await ok(r.main, "rev-parse", "main"), mainBefore);
  assertEquals(await ok(r.main, "status", "--porcelain"), "");
  assertEquals(statuses(items[0])["delete local branch"], "done");
});

Deno.test("a pull that fails for another reason (network) is failed, not skipped", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const real = fakeSwamp(r.main, { 22: merged(wt) });
  const items = await clean(
    { pr: 22, prs: "" },
    (call) =>
      call.method === "pull"
        ? Promise.resolve({
          ok: false,
          error: {
            message:
              "git pull failed (exit 128): fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com",
          },
        })
        : real(call),
  );
  const s = items[0].steps.find((s) => s.step === "fast-forward main")!;
  assertEquals(s.status, "failed");
  assertMatch(s.detail, /Could not resolve host/);
});

Deno.test("a call that throws mid-clean is that step failed, and the rest still reported", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const real = fakeSwamp(r.main, { 22: merged(wt) });
  const items = await clean(
    { pr: 22, prs: "" },
    (call) =>
      call.method === "cleanup_delete_remote_branch"
        ? Promise.reject(new Error("swamp went away"))
        : real(call),
  );
  const s = items[0].steps.find((s) => s.step === "delete origin branch")!;
  assertEquals(s.status, "failed");
  assertMatch(s.detail, /swamp went away/);
  assertEquals(statuses(items[0])["remove worktree"], "done");
  assertEquals(statuses(items[0])["fast-forward main"], "done");
});

// ---- AC8 --------------------------------------------------------------------

Deno.test("AC8: primary: the main checkout is switched to main, fast-forwarded, the branch deleted both places", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "checkout", "-q", "me/feature");
  await mergeOnOrigin(r, "me/feature");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(items[0].verdict, "primary");
  assertEquals(items[0].steps.map((s) => [s.step, s.status]), [
    ["switch to main", "done"],
    ["fast-forward main", "done"],
    ["delete local branch", "done"],
    ["delete origin branch", "done"],
  ]);
  assertEquals(await ok(r.main, "branch", "--show-current"), "main");
  assertEquals(
    await ok(r.main, "rev-parse", "main"),
    await ok(r.origin, "rev-parse", "main"),
  );
  assertEquals(await branchExists(r.main, "me/feature"), false);
  assertEquals(await branchExists(r.origin, "me/feature"), false);
});

Deno.test("AC8: primary in a repo whose default branch is master: switched to master", async () => {
  await using r = await repos({ trunk: "master" });
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "checkout", "-q", "me/feature");
  await mergeOnOrigin(r, "me/feature");
  const items = await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }),
  );
  assertEquals(items[0].verdict, "primary");
  assertEquals(statuses(items[0]), {
    "switch to main": "done",
    "fast-forward main": "done",
    "delete local branch": "done",
    "delete origin branch": "done",
  });
  assertEquals(await ok(r.main, "branch", "--show-current"), "master");
  assertEquals(await branchExists(r.origin, "me/feature"), false);
});

// ---- is_ancestor ----------------------------------------------------------

Deno.test("a PR head git doesn't have is absent, not an error", async () => {
  await using r = await repos();
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const items = await check(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged({ head: unknown, branch: "me/feature" }) }),
  );
  assertEquals(items[0].verdict, "absent");
});

Deno.test("an is_ancestor call that fails for another reason makes the PR an error, not absent", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  const real = fakeSwamp(r.main, { 22: merged(wt) });
  const items = await check(
    { pr: 22, prs: "" },
    (call) =>
      call.method === "is_ancestor"
        ? Promise.resolve({
          ok: false,
          error: {
            message:
              "git merge-base --is-ancestor failed (exit 128): fatal: index file corrupt",
          },
        })
        : real(call),
  );
  assertEquals(items[0].verdict, "error");
  assertMatch(items[0].line, /index file corrupt/);
});

// ---- AC9 --------------------------------------------------------------------

Deno.test("AC9: none named: only the latest 3 merged PRs, then only those with a worktree at their head", async () => {
  await using r = await repos();
  const a = await worktreePr(r, "me/a");
  const b = await worktreePr(r, "me/b");
  const c = await worktreePr(r, "me/c");
  const d = await worktreePr(r, "me/d");
  for (const br of ["me/a", "me/b", "me/c", "me/d"]) await mergeOnOrigin(r, br);
  await ok(r.main, "worktree", "remove", b.path);
  const prs = {
    1: merged(a, "2026-11-01T00:00:00Z"), // oldest: not in the latest 3
    2: merged(b, "2026-11-04T00:00:00Z"), // latest, but no worktree
    3: merged(c, "2026-11-03T00:00:00Z"),
    4: merged(d, "2026-11-02T00:00:00Z"),
    5: {
      title: "open",
      state: "OPEN" as const,
      headRefOid: "f".repeat(40),
      headRefName: "me/e",
    },
  };
  const calls: Calls = [];
  const before = await snapshot(r);
  const checked = await check(
    { pr: 0, prs: "" },
    fakeSwamp(r.main, prs, { calls }),
  );
  assertEquals(checked.map((i) => [i.number, i.verdict]), [[3, "clean"], [
    4,
    "clean",
  ]]);
  assertEquals(await snapshot(r), before);
  assert(calls.some((c) => c.method === "cleanup_merged_prs"));
  const cleaned = await clean({ pr: 0, prs: "" }, fakeSwamp(r.main, prs));
  assertEquals(cleaned.map((i) => i.number), [3, 4]);
  assertEquals(await worktreeExists(r, a.path), true);
  assertEquals(await worktreeExists(r, c.path), false);
  assertEquals(await worktreeExists(r, d.path), false);
  assertEquals(summarise(cleaned, "clean"), "#3 cleaned up, #4 cleaned up");
});

Deno.test("AC9: the latest by merge time: a comment on an old merged PR doesn't push out one just merged", async () => {
  await using r = await repos();
  const a = await worktreePr(r, "me/a");
  const b = await worktreePr(r, "me/b");
  const c = await worktreePr(r, "me/c");
  const d = await worktreePr(r, "me/d");
  for (const br of ["me/a", "me/b", "me/c", "me/d"]) await mergeOnOrigin(r, br);
  const prs = {
    // Merged long ago, but commented on after the others were merged.
    1: {
      ...merged(a, "2026-10-01T00:00:00Z"),
      updatedAt: "2026-11-09T00:00:00Z",
    },
    2: merged(b, "2026-11-04T00:00:00Z"),
    3: merged(c, "2026-11-03T00:00:00Z"),
    4: merged(d, "2026-11-02T00:00:00Z"),
  };
  const checked = await check({ pr: 0, prs: "" }, fakeSwamp(r.main, prs));
  assertEquals(checked.map((i) => i.number), [2, 3, 4]);
});

Deno.test("AC9: none named and nothing to do: no items, 'Nothing to clean up'", async () => {
  await using r = await repos();
  const items = await clean({ pr: 0, prs: "" }, fakeSwamp(r.main, {}));
  assertEquals(items, []);
  assertEquals(summarise(items, "clean"), "Nothing to clean up");
  assertEquals(summarise(items, "check"), "Nothing to clean up");
});

Deno.test("several named: each PR gets its own verdict and steps, main fast-forwarded once", async () => {
  await using r = await repos();
  const a = await worktreePr(r, "me/a");
  const b = await worktreePr(r, "me/b");
  await mergeOnOrigin(r, "me/a");
  await mergeOnOrigin(r, "me/b");
  await Deno.writeTextFile(`${b.path}/wip.txt`, "wip");
  const calls: Calls = [];
  const items = await clean(
    { pr: 7, prs: "8" },
    fakeSwamp(r.main, { 7: merged(a), 8: merged(b) }, { calls }),
  );
  assertEquals(items.map((i) => [i.number, i.verdict]), [[7, "clean"], [
    8,
    "dirty",
  ]]);
  assertEquals(calls.filter((c) => c.method === "pull").length, 1);
  assertEquals(
    summarise(items, "clean"),
    "#7 cleaned up, #8 left as is (dirty)",
  );
  assertEquals(summarise(items, "check"), "#7 clean, #8 dirty");
});

// ---- repo and inputs --------------------------------------------------------

Deno.test("origin that is not on GitHub: refused before anything runs", async () => {
  await using r = await repos();
  await ok(r.main, "config", "remote.origin.url", "https://example.com/x.git");
  let error = "";
  try {
    await clean({ pr: 22, prs: "" }, fakeSwamp(r.main, {}));
  } catch (e) {
    error = String(e);
  }
  assertMatch(error, /not a GitHub remote/);
});

Deno.test("bad prs: refused before any call", async () => {
  const calls: Calls = [];
  let error = "";
  try {
    await clean(
      { pr: 0, prs: "1;rm" },
      fakeSwamp("/nonexistent", {}, { calls }),
    );
  } catch (e) {
    error = String(e);
  }
  assertNotEquals(error, "");
  assertEquals(calls, []);
});

Deno.test("clean only ever leases, never forces: no -D, no --force in any call", async () => {
  await using r = await repos();
  const wt = await mergedPr(r);
  const calls: Calls = [];
  await clean(
    { pr: 22, prs: "" },
    fakeSwamp(r.main, { 22: merged(wt) }, { calls }),
  );
  const text = JSON.stringify(calls);
  assert(!/"force"|-D|--force"/.test(text), text);
  assert(!calls.some((c) => c.method === "push"));
});
