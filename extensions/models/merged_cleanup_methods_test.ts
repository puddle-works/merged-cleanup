/**
 * Tests for the model's three methods: `run` and `check` only read, `clean`
 * writes, and each stores its items with a summary line.
 *
 * Run with: make test
 */
import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { model, ResultSchema, RunArgsSchema } from "./merged_cleanup.ts";
import type { RunModel } from "./_lib/cleanup.ts";
import {
  fakeSwamp,
  mergeOnOrigin,
  ok,
  repos,
  snapshot,
  worktreePr,
} from "./_lib/fixture_test.ts";

type Written = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

async function call(
  method: "run" | "check" | "clean",
  args: Record<string, unknown>,
  runModel?: RunModel,
  logged: string[] = [],
): Promise<Written> {
  const writes: Written[] = [];
  const out = await model.methods[method].execute(RunArgsSchema.parse(args), {
    globalArgs: {},
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        logged.push(msg.replace(/\{(\w+)\}/g, (_m, k) => String(props?.[k]))),
    },
    ...(runModel ? { runModel } : {}),
    writeResource: (specName, name, data) => {
      writes.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  });
  assertEquals(out.dataHandles.length, 1);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "result");
  assertEquals(ResultSchema.safeParse(writes[0].data).success, true);
  return writes[0];
}

async function mergedPr() {
  const r = await repos();
  const wt = await worktreePr(r, "me/feature");
  await mergeOnOrigin(r, "me/feature");
  const run = fakeSwamp(r.main, {
    22: { title: "Add the thing", state: "MERGED", headRefOid: wt.head },
  });
  return { r, wt, run };
}

Deno.test("the model has run, check and clean, on the same arguments", () => {
  assertEquals(Object.keys(model.methods).sort(), ["check", "clean", "run"]);
  for (const m of Object.values(model.methods)) {
    assertEquals(m.arguments, RunArgsSchema);
  }
});

Deno.test("run is read-only: the same items as check, stored as result, nothing changed", async () => {
  const { r, run } = await mergedPr();
  await using _ = r;
  const before = await snapshot(r);
  const ran = await call("run", { pr: 22 }, run);
  const checked = await call("check", { pr: 22 }, run);
  assertEquals(ran.name, "result");
  assertEquals(checked.name, "check");
  assertEquals(ran.data.items, checked.data.items);
  assertEquals(ran.data.summary, "#22 clean");
  assertEquals(await snapshot(r), before);
});

Deno.test("clean cleans up and stores its steps as clean, with the summary", async () => {
  const { r, wt, run } = await mergedPr();
  await using _ = r;
  const out = await call("clean", { pr: 22 }, run);
  assertEquals(out.name, "clean");
  assertEquals(out.data.summary, "#22 cleaned up");
  const items = out.data.items as Array<{ steps: unknown[] }>;
  assertEquals(items[0].steps.length, 4);
  assertEquals(
    (await ok(r.main, "worktree", "list", "--porcelain")).includes(wt.path),
    false,
  );
});

Deno.test("clean logs what it was asked, a line per PR and its summary", async () => {
  const { r, run } = await mergedPr();
  await using _ = r;
  const logged: string[] = [];
  await call("clean", { pr: 22 }, run, logged);
  assertEquals(logged[0], "clean: PRs 22");
  assertMatch(logged[1], /^#22 \(Add the thing\)/);
  assertEquals(logged.at(-1), "#22 cleaned up");
});

Deno.test("check with none named says so in its first log line", async () => {
  await using r = await repos();
  const logged: string[] = [];
  await call("check", {}, fakeSwamp(r.main, {}), logged);
  assertEquals(logged, [
    "check: the latest 3 merged PRs",
    "Nothing to clean up",
  ]);
});

Deno.test("nothing to clean up: no items and the summary says so", async () => {
  await using r = await repos();
  const out = await call("clean", {}, fakeSwamp(r.main, {}));
  assertEquals(out.data.items, []);
  assertEquals(out.data.summary, "Nothing to clean up");
});

Deno.test("without runModel each method refuses", async () => {
  for (const m of ["run", "check", "clean"] as const) {
    const err = await assertRejects(() => call(m, { pr: 22 }));
    assertMatch(String(err), /runModel is not available/);
  }
});
