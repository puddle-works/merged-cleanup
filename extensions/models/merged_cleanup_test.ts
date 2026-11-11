/**
 * Tests for @puddleworks/merged-cleanup.
 *
 * Run with the "Test it" command in README.md.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { assertSpyCallArgs, stub } from "jsr:@std/testing@1.0.21/mock";
import {
  behaviour,
  type GlobalArgs,
  GlobalArgsSchema,
  model,
  ResultSchema,
  RunArgsSchema,
} from "./merged_cleanup.ts";

/** Values for the required inputs. */
const REQUIRED = {};

/**
 * Placeholders that only need to pass the schema: these tests stub `run`.
 * Tests of the real behaviour call `run` with working settings of their own.
 */
const SETTINGS: GlobalArgs = {};

Deno.test("model type matches the app spec", () => {
  assertEquals(model.type, "@puddleworks/merged-cleanup");
});

Deno.test("run arguments are exactly the specification inputs", () => {
  assertEquals(Object.keys(RunArgsSchema.shape).sort(), ["pr", "prs"]);
});

Deno.test("run arguments apply the specification defaults", () => {
  assertEquals(RunArgsSchema.parse(REQUIRED), { pr: 0, prs: "" });
});

Deno.test("run arguments reject values of the wrong type", () => {
  const wrong: Array<[string, unknown]> = [
    ["pr", 1.5],
    ["prs", 1],
  ];
  for (const [name, value] of wrong) {
    assertEquals(
      RunArgsSchema.safeParse({ ...REQUIRED, [name]: value }).success,
      false,
      name,
    );
  }
});

Deno.test("run writes one result resource with the arguments it ran with", async () => {
  using runStub = stub(behaviour, "run", () => Promise.resolve([]));
  const args = RunArgsSchema.parse(REQUIRED);
  const writes: Array<{ specName: string; data: Record<string, unknown> }> = [];
  const out = await model.methods.run.execute(args, {
    globalArgs: SETTINGS,
    writeResource: (specName, name, data) => {
      writes.push({ specName, data });
      return Promise.resolve({ name });
    },
  });
  assertEquals(out.dataHandles.length, 1);
  assertSpyCallArgs(runStub, 0, [args, SETTINGS]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "result");
  assertEquals(writes[0].data.args, args);
  assertEquals(ResultSchema.safeParse(writes[0].data).success, true);
});
