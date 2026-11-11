/**
 * Tests for the placeholder model that ships with the puddle template.
 *
 * Run with: make test
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { greet, model } from "./example.ts";

Deno.test("model type is the template placeholder", () => {
  assertEquals(model.type, "@puddleworks/puddle-template");
});

Deno.test("greet greets the given name", () => {
  const greeting = greet({ name: "Ada" }, new Date("2026-01-02T03:04:05Z"));
  assertEquals(greeting, {
    name: "Ada",
    message: "Hello, Ada",
    greetedAt: "2026-01-02T03:04:05.000Z",
  });
});

Deno.test("greet rejects an empty name", () => {
  assertThrows(
    () => greet({ name: "  " }, new Date()),
    Error,
    "must not be empty",
  );
});

Deno.test("the greet method stores one greeting resource", async () => {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const result = await model.methods.greet.execute(
    { name: "Ada" },
    {
      globalArgs: {},
      writeResource: (spec, name, data) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      logger: { info: () => {} },
    },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "greeting");
  assertEquals(result.dataHandles.length, 1);
});
