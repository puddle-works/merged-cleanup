/**
 * Tests for the two recipe workflows and the manifest: each recipe is read the
 * way @puddleworks/recipes reads a pack's workflow (one model_method step, its
 * inputs fed only by declared captures), its pattern is held to the whole
 * turn, and its text is rendered from a `clean` result.
 *
 * Run with: make test
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { parse } from "jsr:@std/yaml@1";

const root = new URL("../../", import.meta.url);
const read = async (path: string) =>
  parse(await Deno.readTextFile(new URL(path, root))) as Record<
    string,
    unknown
  >;

const REQUEST =
  "http://127.0.0.1:3002/requests/2c4c963a-b14d-403f-9b1f-2bdabbc71c19";

interface Recipe {
  id: string;
  extension: string;
  pattern: string;
  dataName: string;
  inputs?: Record<string, { capture: number; as: string }>;
  each: { path: string; line: string };
  template: string;
  empty: string;
  source: { url: string; version: number };
}

interface Step {
  task: {
    type: string;
    modelIdOrName: string;
    methodName: string;
    inputs?: Record<string, unknown>;
  };
}

async function recipe(file: string) {
  const wf = await read(`workflows/${file}`);
  const tags = wf.tags as Record<string, string>;
  const r = JSON.parse(tags.puddlerouterRecipe) as Recipe;
  const steps = (wf.jobs as Array<{ steps: Step[] }>).flatMap((j) => j.steps);
  // The engine holds a pattern to the whole turn, ignoring case.
  const whole = new RegExp(`^(?:${r.pattern})$`, "i");
  return { wf, r, steps, whole };
}

/** The engine's fill and render, for a result with `each`. */
function fill(template: string, data: unknown): string {
  return template.replace(/\{([\w.]+)\}/g, (_w, path: string) => {
    let v: unknown = data;
    for (const k of path.split(".")) {
      v = typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)[k]
        : undefined;
    }
    return v === undefined || v === null ? "" : String(v);
  });
}
function render(r: Recipe, attrs: Record<string, unknown>): string {
  const list = attrs[r.each.path] as unknown[];
  if (list.length === 0) return r.empty;
  const lines = list.slice(0, 20).map((i) => fill(r.each.line, i)).join("\n");
  return fill(r.template, { ...attrs, count: list.length, lines });
}

const ANY_TURN = [
  "",
  "x",
  "please fix the bug in this file",
  "what should we do next?",
  "Refactor the login page, then run the tests.",
];
const NOT_OURS = [
  "merged the docs",
  "is 22 merged?",
  "22 is not merged",
  "merge 22",
  "unmerged",
  "1234567 is merged",
];

Deno.test("the numbered recipe: one clean step on merged-cleanup-model, pr from capture 1", async () => {
  const { wf, r, steps } = await recipe("workflow-merged-cleanup-recipe.yaml");
  assertEquals(wf.name, "@puddleworks/merged-cleanup-recipe");
  assertEquals(r.id, "merged-cleanup");
  assertEquals(r.extension, "@puddleworks/merged-cleanup");
  assertEquals(r.dataName, "clean");
  assertEquals(r.inputs, { pr: { capture: 1, as: "int" } });
  assertEquals(steps.length, 1);
  assertEquals(steps[0].task, {
    type: "model_method",
    modelIdOrName: "merged-cleanup-model",
    methodName: "clean",
    inputs: { pr: "${{ inputs.pr }}" },
  });
  assertEquals(r.source, { url: REQUEST, version: 2 });
});

Deno.test("the numbered recipe matches the spec's phrases and gives the PR number", async () => {
  const { whole } = await recipe("workflow-merged-cleanup-recipe.yaml");
  for (
    const [text, n] of [
      ["22 is merged", "22"],
      ["pr 22 is merged", "22"],
      ["#22 merged", "22"],
      ["PR #22 has been merged.", "22"],
      ["pr22 was merged!", "22"],
    ]
  ) {
    assertEquals(whole.exec(text)?.[1], n, text);
  }
  for (const text of [...ANY_TURN, ...NOT_OURS, "merged"]) {
    assertEquals(whole.test(text), false, text);
  }
});

Deno.test("the latest recipe: bare 'merged', no inputs, the same clean step", async () => {
  const { wf, r, steps, whole } = await recipe(
    "workflow-merged-cleanup-latest-recipe.yaml",
  );
  assertEquals(wf.name, "@puddleworks/merged-cleanup-latest-recipe");
  assertEquals(r.id, "merged-cleanup-latest");
  assertEquals(r.extension, "@puddleworks/merged-cleanup");
  assertEquals(r.dataName, "clean");
  assertEquals(r.inputs ?? {}, {});
  assertEquals(steps.length, 1);
  assertEquals(steps[0].task.methodName, "clean");
  assertEquals(steps[0].task.modelIdOrName, "merged-cleanup-model");
  assertEquals(steps[0].task.inputs ?? {}, {});
  for (const text of ["merged", "Merged.", "merged!"]) {
    assert(whole.test(text), text);
  }
  for (const text of [...ANY_TURN, ...NOT_OURS, "22 is merged"]) {
    assertEquals(whole.test(text), false, text);
  }
});

Deno.test("both recipes render one line per PR, then the summary; none gives the empty text", async () => {
  for (
    const file of [
      "workflow-merged-cleanup-recipe.yaml",
      "workflow-merged-cleanup-latest-recipe.yaml",
    ]
  ) {
    const { r } = await recipe(file);
    const result = {
      items: [
        { number: 22, line: "#22 (Add the thing): worktree removed" },
        { number: 23, line: "#23 (Other): left as is: dirty" },
      ],
      summary: "#22 cleaned up, #23 left as is (dirty)",
    };
    assertEquals(
      render(r, result),
      "#22 (Add the thing): worktree removed\n#23 (Other): left as is: dirty\n" +
        "#22 cleaned up, #23 left as is (dirty)",
    );
    assertEquals(
      render(r, { items: [], summary: "Nothing to clean up" }),
      "Nothing to clean up.",
    );
  }
});

Deno.test("the manifest says it writes, offers its recipes and lists what it calls", async () => {
  const m = await read("manifest.yaml");
  const labels = m.labels as string[];
  assert(labels.includes("effects-write"));
  assert(!labels.includes("effects-read"));
  assert(labels.includes("puddlerouter-recipe"));
  assertEquals(m.models, [
    "merged_cleanup.ts",
    "git_cleanup.ts",
    "github_cleanup.ts",
  ]);
  assertEquals(m.workflows, [
    "workflow-merged-cleanup.yaml",
    "workflow-merged-cleanup-recipe.yaml",
    "workflow-merged-cleanup-latest-recipe.yaml",
  ]);
  assertEquals(m.dependencies, ["@swamp/git", "@webframp/github"]);
});
