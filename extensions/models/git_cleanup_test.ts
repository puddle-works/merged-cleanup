/**
 * Tests for the four methods this extension adds to `@swamp/git`, on real
 * git repos.
 *
 * Run with: make test
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { extension, parseWorktreeList } from "./git_cleanup.ts";
import {
  git,
  mergeOnOrigin,
  ok,
  pushToOrigin,
  repos,
  worktreePr,
} from "./_lib/fixture_test.ts";

type Method = {
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
};
const methods = Object.assign({}, ...extension.methods) as Record<
  string,
  Method
>;

async function call(
  method: string,
  repoPath: string,
  args: Record<string, unknown> = {},
  logged: string[] = [],
): Promise<Record<string, unknown>> {
  const written: Record<string, unknown>[] = [];
  await methods[method].execute(args, {
    globalArgs: { repoPath },
    logger: { info: (msg: string) => logged.push(msg) },
    writeResource: (
      _s: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  });
  assertEquals(written.length, 1);
  return written[0];
}

Deno.test("the extension adds four methods to @swamp/git, none named as puddlerouter's", () => {
  assertEquals(extension.type, "@swamp/git");
  assertEquals(Object.keys(methods).sort(), [
    "cleanup_branch_heads",
    "cleanup_delete_branch",
    "cleanup_delete_remote_branch",
    "cleanup_worktree_list",
  ]);
});

Deno.test("parseWorktreeList reads the main checkout, a branch, a locked and a detached worktree", () => {
  const list = parseWorktreeList(
    [
      "worktree /r",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /w1",
      "HEAD bbb",
      "branch refs/heads/me/x",
      "locked because",
      "",
      "worktree /w2",
      "HEAD ccc",
      "detached",
      "",
    ].join("\n"),
  );
  assertEquals(list.map((w) => [w.path, w.head, w.branch, w.primary]), [
    ["/r", "aaa", "main", true],
    ["/w1", "bbb", "me/x", false],
    ["/w2", "ccc", "", false],
  ]);
  assertEquals(list.map((w) => w.locked), [false, true, false]);
  assertEquals(list[2].detached, true);
});

Deno.test("cleanup_worktree_list lists the repo's worktrees", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/x");
  await ok(r.main, "worktree", "lock", wt.path);
  const out = await call("cleanup_worktree_list", r.main);
  const list = out.worktrees as Array<Record<string, unknown>>;
  assertEquals(list.length, 2);
  assertEquals(list[0].path, r.main);
  assertEquals(list[0].primary, true);
  assertEquals(list[1].path, wt.path);
  assertEquals(list[1].head, wt.head);
  assertEquals(list[1].branch, "me/x");
  assertEquals(list[1].locked, true);
});

Deno.test("cleanup_branch_heads lists local branches and origin's, each with its head, and changes nothing", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  await ok(r.main, "branch", "-q", "me/local-only", r.trunk);
  const trunk = await ok(r.main, "rev-parse", r.trunk);
  const before = await ok(r.main, "for-each-ref");
  const out = await call("cleanup_branch_heads", r.main);
  const byName = (l: unknown) =>
    Object.fromEntries(
      (l as { name: string; head: string }[]).map((b) => [b.name, b.head]),
    );
  assertEquals(byName(out.localBranches), {
    [r.trunk]: trunk,
    "me/feature": wt.head,
    "me/local-only": trunk,
  });
  // origin's come from ls-remote, not from (maybe stale) tracking refs.
  await ok(r.other, "push", "-q", "origin", "--delete", "me/feature");
  const after = await call("cleanup_branch_heads", r.main);
  assertEquals(byName(after.originBranches), { [r.trunk]: trunk });
  assertEquals(await ok(r.main, "for-each-ref"), before);
});

Deno.test("cleanup_branch_heads: a folder that is not a git repo is an error", async () => {
  await using r = await repos();
  await assertRejects(() => call("cleanup_branch_heads", r.root));
});

Deno.test("cleanup_delete_branch deletes a merged branch with -d", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/x");
  await mergeOnOrigin(r, "me/x");
  await ok(r.main, "worktree", "remove", wt.path);
  const out = await call("cleanup_delete_branch", r.main, { branch: "me/x" });
  assertEquals(out.deleted, true);
  assertEquals(out.alreadyAbsent, false);
  const left = await git(
    r.main,
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/heads/me/x",
  );
  assertEquals(left.code, 1);
});

Deno.test("cleanup_delete_branch reports a branch already gone", async () => {
  await using r = await repos();
  const out = await call("cleanup_delete_branch", r.main, {
    branch: "me/gone",
  });
  assertEquals(out.deleted, false);
  assertEquals(out.alreadyAbsent, true);
});

Deno.test("cleanup_delete_branch: a folder that is not a git repo is an error, not already gone", async () => {
  await using r = await repos();
  const notRepo = `${r.root}/not-a-repo`;
  await Deno.mkdir(notRepo);
  await assertRejects(
    () => call("cleanup_delete_branch", notRepo, { branch: "me/feature" }),
    Error,
    "could not read branch me/feature",
  );
});

Deno.test("the delete methods log before they act and when they are done", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await ok(r.main, "worktree", "remove", wt.path);
  for (
    const [method, args] of [
      // Local first: -d accepts it while its upstream is still there.
      ["cleanup_delete_branch", { branch: "me/feature" }],
      ["cleanup_delete_remote_branch", {
        branch: "me/feature",
        expect: wt.head,
      }],
    ] as const
  ) {
    const logged: string[] = [];
    await call(method, r.main, args, logged);
    assertEquals(logged.length, 2, logged.join(" | "));
    assertMatch(logged[0], /^Deleting /);
    assertMatch(logged[1], /\{what\}$/);
  }
});

Deno.test("cleanup_delete_branch refuses an unmerged branch with no upstream, and never forces", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/sq", { upstream: false });
  await mergeOnOrigin(r, "me/sq", "squash");
  await ok(r.main, "worktree", "remove", wt.path);
  const err = await assertRejects(() =>
    call("cleanup_delete_branch", r.main, { branch: "me/sq" })
  );
  assert(String(err).includes("not fully merged"), String(err));
  assertEquals(await ok(r.main, "rev-parse", "refs/heads/me/sq"), wt.head);
});

Deno.test("cleanup_delete_branch refuses main, master and names that look like options", async () => {
  await using r = await repos();
  for (const branch of ["main", "master", "-D", "--force", "a..b", ""]) {
    await assertRejects(
      () => call("cleanup_delete_branch", r.main, { branch }),
      Error,
      undefined,
      branch,
    );
  }
  assertEquals(
    (await git(r.main, "rev-parse", "--verify", "refs/heads/main")).code,
    0,
  );
});

Deno.test("cleanup_delete_remote_branch deletes origin's branch at the expected head", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/x");
  const out = await call("cleanup_delete_remote_branch", r.main, {
    branch: "me/x",
    expect: wt.head,
  });
  assertEquals(out.deleted, true);
  assertEquals(await ok(r.origin, "for-each-ref", "refs/heads/me/x"), "");
});

Deno.test("cleanup_delete_remote_branch reports origin's branch already gone", async () => {
  await using r = await repos();
  const out = await call("cleanup_delete_remote_branch", r.main, {
    branch: "me/gone",
    expect: "a".repeat(40),
  });
  assertEquals(out.deleted, false);
  assertEquals(out.alreadyAbsent, true);
});

Deno.test("cleanup_delete_remote_branch: the lease alone refuses a branch that moved", async () => {
  await using r = await repos();
  const wt = await worktreePr(r, "me/x");
  const later = await pushToOrigin(r, "me/x");
  await assertRejects(() =>
    call("cleanup_delete_remote_branch", r.main, {
      branch: "me/x",
      expect: wt.head,
    })
  );
  assertEquals(
    await ok(r.origin, "rev-parse", "refs/heads/me/x"),
    later,
  );
});

Deno.test("cleanup_delete_remote_branch needs a full commit id and refuses main", async () => {
  await using r = await repos();
  const head = await ok(r.main, "rev-parse", "HEAD");
  await assertRejects(() =>
    call("cleanup_delete_remote_branch", r.main, { branch: "x", expect: "abc" })
  );
  await assertRejects(() =>
    call("cleanup_delete_remote_branch", r.main, {
      branch: "main",
      expect: head,
    })
  );
  assertEquals(await ok(r.origin, "rev-parse", "refs/heads/main"), head);
});
