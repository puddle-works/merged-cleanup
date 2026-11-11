import type { Contracts } from "https://raw.githubusercontent.com/puddle-works/puddle-tooling/v0.1.1/contracts/check.ts";
import { model as example } from "./extensions/models/example.ts";

// Maps each model instance a workflow reads with data.latest(...) to its type
// and the data names it writes. The placeholder workflow reads nothing, so the
// entry only shows the shape.
export const CONTRACTS: Contracts = {
  example: { model: example, data: { greeting: "greeting" } },
};
