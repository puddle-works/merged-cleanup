/**
 * @puddleworks/puddle-template — placeholder model that ships with the template
 *
 * It exists so a repo made from the template passes `make test` and a publish
 * dry run before anyone has written anything. draft-build (or the builder)
 * replaces it with the puddle's real extension.
 *
 * Output: a `greeting` resource holding the name, the message and the time.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The placeholder takes no settings. */
export const GlobalArgsSchema = z.object({});
/** The settings of one model instance (none). */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `greet`. */
export const GreetArgsSchema = z.object({
  name: z.string().default("world").describe("Who to greet."),
});
/** The arguments `greet` accepts. */
export type GreetArgs = z.infer<typeof GreetArgsSchema>;

/** What one `greet` stores. */
export const GreetingSchema = z.object({
  /** The name as given. */
  name: z.string(),
  /** The greeting. */
  message: z.string(),
  /** When the greeting was made. */
  greetedAt: z.iso.datetime(),
});
/** The stored result of one `greet`. */
export type Greeting = z.infer<typeof GreetingSchema>;

/** Greets `args.name`, stamped `now`. */
export function greet(args: GreetArgs, now: Date): Greeting {
  if (!args.name.trim()) throw new Error("The name must not be empty.");
  return {
    name: args.name,
    message: `Hello, ${args.name}`,
    greetedAt: now.toISOString(),
  };
}

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
}

/** The model type: one `greet` method that stores its answer as `greeting`. */
export const model = {
  type: "@puddleworks/puddle-template",
  version: "2026.10.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    greeting: {
      description: "The last greeting.",
      schema: GreetingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    greet: {
      description: "Greet a name.",
      arguments: GreetArgsSchema,
      execute: async (args: GreetArgs, context: MethodContext) => {
        context.logger.info("Greeting {name}", { name: args.name });
        const greeting = greet(args, new Date());
        const handle = await context.writeResource(
          "greeting",
          "greeting",
          greeting,
        );
        context.logger.info("Stored {message}", { message: greeting.message });
        return { dataHandles: [handle] };
      },
    },
  },
};
