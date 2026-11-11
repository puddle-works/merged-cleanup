/**
 * Checks across the repo's workflow files. swamp only loads a workflow whose
 * file is named workflow-*.yaml and that has an id. It skips any other file
 * without a word, so `swamp workflow validate` and `workflow run` would not
 * see it.
 *
 * Run with: make test
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";

const dir = new URL("../../workflows/", import.meta.url);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("every workflow has its own UUID id", async () => {
  const ids: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".yaml")) continue;
    assertMatch(
      entry.name,
      /^workflow-/,
      `${entry.name} is not workflow-*.yaml`,
    );
    const wf = parse(await Deno.readTextFile(new URL(entry.name, dir))) as {
      id?: string;
    };
    assert(wf.id, `${entry.name} has no id`);
    assertMatch(wf.id, uuid, `${entry.name} id is not a UUID`);
    ids.push(wf.id);
  }
  assert(ids.length > 0, "no workflows found");
  assertEquals(new Set(ids).size, ids.length, "two workflows share an id");
});
