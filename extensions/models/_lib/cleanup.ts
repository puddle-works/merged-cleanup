/**
 * Check and clean up merged PRs in the repository swamp runs in.
 *
 * `inspect` is puddlerouter's merged check (`_lib/merged.ts`), kept as it is
 * so that file can move here later: it finds each PR, checks it is merged and
 * finds the worktree it was built in. A worktree only counts as safe to remove
 * when its HEAD is the merged PR's head commit and it has no uncommitted
 * changes, so no commit can be orphaned.
 *
 * `act` then cleans up each PR found `clean` or `primary`, checking again
 * before every step that changes anything, so what changed since the check is
 * left alone and said why. It never forces: worktrees go with a plain
 * `git worktree remove`, branches with `git branch -d`, origin's branch with a
 * lease on the PR's head, and main only fast-forwards.
 *
 * Git and GitHub go through `runModel`, to the instances `git` (`@swamp/git`)
 * and `github` (`@webframp/github`).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { latestMerged } from "../github_cleanup.ts";

/** One call to another model's method; `runModel` in a method context. */
export interface ModelCall {
  modelType: string;
  name: string;
  method: string;
  arguments?: Record<string, unknown>;
}
/** What `runModel` gives back: the data written, or why it failed. */
export type RunResult =
  | {
    ok: true;
    resources: {
      name: string;
      specName?: string;
      attributes?: Record<string, unknown>;
    }[];
  }
  | { ok: false; error: { message: string } };
/** Runs another model's method in process. */
export type RunModel = (call: ModelCall) => Promise<RunResult>;

const GIT = { modelType: "@swamp/git", name: "git" };
const GITHUB = { modelType: "@webframp/github", name: "github" };

/** Most PRs one run may name. */
const MAX_NUMBERS = 5;
/** How many merged PRs "none named" looks at, newest first. */
export const LATEST = 3;
/** Worktrees checked for commits after a PR's head. */
const MAX_ANCESTRY = 10;

/** The PR numbers to look at: `pr` (0 for none) then `prs`; throws if bad. */
export function prNumbers(pr: number, prs: string): number[] {
  if (!Number.isInteger(pr) || pr < 0 || pr > 999_999) {
    throw new Error(`pr must be a PR number, or 0 for none: ${pr}`);
  }
  const out = pr > 0 ? [pr] : [];
  if (prs.trim() !== "") {
    for (const part of prs.split(",")) {
      const p = part.trim();
      if (!/^\d{1,6}$/.test(p) || Number(p) === 0) {
        throw new Error(
          `prs must be PR numbers separated by commas, digits only: "${prs}"`,
        );
      }
      out.push(Number(p));
    }
  }
  const numbers = [...new Set(out)];
  if (numbers.length > MAX_NUMBERS) {
    throw new Error(
      `at most ${MAX_NUMBERS} PRs at once, not ${numbers.length}`,
    );
  }
  return numbers;
}

/** What happened to one step of a PR's clean-up. */
export const StepSchema = z.object({
  step: z.enum([
    "remove worktree",
    "switch to main",
    "fast-forward main",
    "delete local branch",
    "delete origin branch",
  ]),
  status: z.enum(["done", "already done", "skipped", "failed"]),
  /** What was done, why it was skipped, or git's error. */
  detail: z.string(),
});
/** One step. */
export type Step = z.infer<typeof StepSchema>;

const VERDICTS = [
  "clean",
  "primary",
  "dirty",
  "locked",
  "ahead",
  "absent",
  "open",
  "closed",
  "error",
] as const;

/** One PR: what the check found and, for clean, each step. */
export const ItemSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  /** GitHub's state: MERGED, OPEN or CLOSED; empty if it could not be read. */
  state: z.string(),
  /**
   * clean: safe to remove; primary: the main checkout is on the PR's branch;
   * dirty: uncommitted changes; locked: its worktree is locked; ahead: commits
   * after the PR's head; absent: no worktree at or after its head and no one
   * branch left at it (a clean PR's worktree may be "" when only its branch is
   * left); open or
   * closed: not merged; error: could not be checked.
   */
  verdict: z.enum(VERDICTS),
  worktree: z.string(),
  branch: z.string(),
  /** True when `worktree` is the main checkout. */
  primary: z.boolean(),
  /** Why the verdict, in one line. */
  reason: z.string(),
  /** `clean`'s steps, in order; empty for `check` and for a PR left as is. */
  steps: z.array(StepSchema),
  /** The PR in one line, for a reply. */
  line: z.string(),
});
/** One PR's item. */
export type Item = z.infer<typeof ItemSchema>;

/** What the check found for one PR, with the head it was checked at. */
export type Finding = Omit<Item, "steps" | "line"> & { head: string };

/** What `inspect` found. */
export interface Inspection {
  /** owner/name of origin on GitHub. */
  repo: string;
  mainCheckout: string;
  /** The main checkout's branch at the check. */
  mainBranch: string;
  findings: Finding[];
  /** The PR numbers looked up. */
  checked: number[];
}

interface Worktree {
  path: string;
  head: string;
  branch: string;
  primary: boolean;
  detached: boolean;
  bare: boolean;
  locked?: boolean;
}

async function attrs(
  run: RunModel,
  target: { modelType: string; name: string },
  method: string,
  args?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await run({ ...target, method, arguments: args });
  if (!res.ok) throw new Error(res.error.message.trim());
  return res.resources[0]?.attributes ?? {};
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** owner/name for a GitHub remote URL (https or ssh), else null. */
function githubRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** git's words for a commit or ref the repo doesn't have. */
const UNKNOWN_COMMIT =
  /not a valid commit name|not a valid object name|bad object|unknown revision/i;

/** git refusing a pull --ff-only because the branches have diverged. */
const NO_FAST_FORWARD =
  /not possible to fast-forward|can't be fast-forwarded|diverg/i;

const isMain = (branch: string) => branch === "main" || branch === "master";

function oneLine(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function worktreesOf(
  run: RunModel,
  repoPath?: string,
): Promise<Worktree[]> {
  const list = await attrs(
    run,
    GIT,
    "cleanup_worktree_list",
    repoPath ? { repoPath } : undefined,
  );
  return Array.isArray(list.worktrees) ? (list.worktrees as Worktree[]) : [];
}

async function isClean(run: RunModel, path: string): Promise<boolean> {
  const status = await attrs(run, GIT, "status", { repoPath: path });
  return status.clean === true &&
    (!Array.isArray(status.entries) || status.entries.length === 0);
}

function reasonFor(f: Omit<Finding, "reason">, note: string): string {
  const place = !f.worktree
    ? `the local branch ${f.branch}`
    : f.primary
    ? `the main checkout ${f.worktree} (branch ${f.branch})`
    : `the worktree ${f.worktree} (branch ${f.branch})`;
  switch (f.verdict) {
    case "clean":
      if (!f.worktree) {
        return `its worktree is already gone, but branch ${f.branch} is ` +
          "left; it is deleted with -d, and on origin only at its head";
      }
      return `the worktree ${f.worktree} (branch ${f.branch}) is at its head ` +
        "with no uncommitted changes, so removing it orphans no commits";
    case "primary":
      return `the main checkout ${f.worktree} is on its branch ${f.branch}, ` +
        "at its head, with no uncommitted changes";
    case "dirty":
      return `${place} has uncommitted changes, which ` +
        "removing it would lose";
    case "locked":
      return `${place} is locked; unlock it first if it ` +
        "is safe to remove";
    case "ahead":
      return `${place} has commits after ` +
        `#${f.number}'s head, which would be orphaned`;
    case "absent":
      return `no worktree is at ${note ? "" : "or after "}#${f.number}'s ` +
        "head; it may be cleaned up already";
    case "open":
    case "closed":
      return `it is ${f.verdict}, not merged`;
    case "error":
      return `could not be checked: ${note}`;
  }
}

function finding(
  base: Omit<Finding, "verdict" | "worktree" | "branch" | "primary" | "reason">,
  verdict: Finding["verdict"],
  w: Worktree | undefined,
  note = "",
): Finding {
  const f = {
    ...base,
    verdict,
    worktree: w?.path ?? "",
    branch: w?.branch ?? "",
    primary: w?.primary ?? false,
  };
  return { ...f, reason: reasonFor(f, note) };
}

function errorFinding(n: number, e: unknown): Finding {
  return finding(
    { number: n, title: "", url: "", state: "", head: "" },
    "error",
    undefined,
    message(e),
  );
}

/**
 * Check the PRs named (or, for none, the latest merged ones that still have
 * a worktree at their head). Only reads. Throws if the repo can't be read.
 */
export async function inspect(
  numbers: number[],
  run: RunModel,
): Promise<Inspection> {
  const config = await attrs(run, GIT, "config", { key: "remote.origin.url" });
  const repo = githubRepo(str(config.value));
  if (!repo) throw new Error("origin is not a GitHub remote");
  const worktrees = await worktreesOf(run);
  const main = worktrees.find((w) => w.primary);
  const mainCheckout = main?.path ?? "";
  const at = mainCheckout ? { repoPath: mainCheckout } : {};
  const mainRef = `origin/${
    isMain(main?.branch ?? "") ? main!.branch : "main"
  }`;
  const isAncestor = async (ancestor: string, descendant: string) => {
    const res = await run({
      ...GIT,
      method: "is_ancestor",
      arguments: { ...at, ancestor, descendant },
    });
    if (res.ok) return res.resources[0]?.attributes?.isAncestor === true;
    // A commit this repo doesn't have is in none of its branches; any other
    // failure is the PR's error, not a quiet "no".
    if (UNKNOWN_COMMIT.test(res.error.message)) return false;
    throw new Error(oneLine(res.error.message, 160));
  };
  // Each branch's head, here and on origin: read once, and only for a named
  // PR with no worktree, to find a branch Orca left behind.
  type Heads = Map<string, string>;
  let heads: Promise<{ local: Heads; origin: Heads }> | undefined;
  const toMap = (v: unknown): Heads =>
    new Map(
      (Array.isArray(v) ? v : []).map((b: { name?: unknown; head?: unknown }) =>
        [str(b?.name), str(b?.head)] as [string, string]
      ),
    );
  const branchHeads = () =>
    heads ??= attrs(run, GIT, "cleanup_branch_heads", at).then((a) => ({
      local: toMap(a.localBranches),
      origin: toMap(a.originBranches),
    }));
  /** The PR's branch left at its head with no worktree, if just one is. */
  const leftBehind = async (
    base: Omit<
      Finding,
      "verdict" | "worktree" | "branch" | "primary" | "reason"
    >,
  ): Promise<Finding | undefined> => {
    const { local, origin } = await branchHeads();
    const names = [
      ...new Set(
        [...local, ...origin].filter(([n, h]) => h === base.head && !isMain(n))
          .map(([n]) => n),
      ),
    ].sort();
    if (!names.length) return undefined;
    if (names.length > 1) {
      return {
        ...finding(base, "absent", undefined),
        reason: `no worktree is at #${base.number}'s head, and more than one ` +
          `branch is (${names.join(", ")}), so none is touched`,
      };
    }
    const gone: Worktree = {
      path: "",
      head: local.get(names[0]) ?? base.head,
      branch: names[0],
      primary: false,
      detached: false,
      bare: false,
    };
    const ahead = gone.head !== base.head &&
      await isAncestor(base.head, gone.head);
    return finding(base, ahead ? "ahead" : "clean", gone);
  };
  const branched = worktrees.filter((w) =>
    w.head && !w.bare && !w.detached && !isMain(w.branch)
  );

  const lookUp = async (n: number) => {
    const c = (await attrs(run, GITHUB, "get_pull_request_context", {
      repo,
      number: n,
      maxComments: 1,
    })).context as Record<string, unknown> | undefined;
    const state = str(c?.state).toUpperCase();
    // A PR with no state (or one GitHub has not told us of) is an error, never
    // taken for closed.
    if (!["MERGED", "OPEN", "CLOSED"].includes(state)) {
      throw new Error(`GitHub gave PR #${n} no state`);
    }
    return {
      number: n,
      title: oneLine(str(c?.title)),
      url: str(c?.url),
      state,
      head: str(c?.headRefOid),
    };
  };

  // GitHub is asked about every PR at once; each answer (or its error) is
  // then used in order, so a failed lookup only makes that PR an error.
  const lookUpAll = (ns: number[]) => Promise.allSettled(ns.map(lookUp));
  const settled = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  };

  const atHead = async (
    base: Awaited<ReturnType<typeof lookUp>>,
    w: Worktree,
  ): Promise<Finding> => {
    const clean = await isClean(run, w.path);
    const verdict = !clean
      ? "dirty"
      : w.locked
      ? "locked"
      : w.primary
      ? "primary"
      : "clean";
    return finding(base, verdict, w);
  };

  const findings: Finding[] = [];
  let checked = numbers;
  if (numbers.length) {
    const bases = await lookUpAll(numbers);
    for (const [i, n] of numbers.entries()) {
      try {
        const base = settled(bases[i]);
        if (base.state !== "MERGED") {
          findings.push(
            finding(base, base.state === "OPEN" ? "open" : "closed", undefined),
          );
          continue;
        }
        const head = base.head;
        const w = head ? branched.find((w) => w.head === head) : undefined;
        if (w) {
          findings.push(await atHead(base, w));
          continue;
        }
        // A head already on main (a merge commit) is in every later branch,
        // so only a head that is not shows work carried on after the PR.
        const onMain = head ? await isAncestor(head, mainRef) : false;
        let ahead: Worktree | undefined;
        for (
          const c of head && !onMain ? branched.slice(0, MAX_ANCESTRY) : []
        ) {
          if (await isAncestor(head, c.head)) {
            ahead = c;
            break;
          }
        }
        if (ahead) {
          findings.push(finding(base, "ahead", ahead));
          continue;
        }
        findings.push(
          (head ? await leftBehind(base) : undefined) ??
            finding(base, "absent", undefined, onMain ? "head on main" : ""),
        );
      } catch (e) {
        findings.push(errorFinding(n, e));
      }
    }
  } else {
    // Our own method: list_prs gives no merge time.
    const list = await attrs(run, GITHUB, "cleanup_merged_prs", { repo });
    checked = latestMerged(list.pullRequests)
      .slice(0, LATEST)
      .map((r) => r.number);
    const bases = await lookUpAll(checked);
    for (const [i, n] of checked.entries()) {
      try {
        const base = settled(bases[i]);
        const w = base.head
          ? branched.find((w) => w.head === base.head)
          : undefined;
        if (base.state === "MERGED" && w) findings.push(await atHead(base, w));
      } catch (e) {
        findings.push(errorFinding(n, e));
      }
    }
  }
  return {
    repo,
    mainCheckout,
    mainBranch: main?.branch ?? "",
    findings,
    checked,
  };
}

const PHRASES: Record<Step["step"], Record<"ok" | "already" | "not", string>> =
  {
    "remove worktree": {
      ok: "worktree removed",
      already: "worktree already gone",
      not: "worktree not removed",
    },
    "switch to main": {
      ok: "switched to main",
      already: "already on main",
      not: "not switched to main",
    },
    "fast-forward main": {
      ok: "main fast-forwarded",
      already: "main already up to date",
      not: "main not fast-forwarded",
    },
    "delete local branch": {
      ok: "local branch deleted",
      already: "local branch already gone",
      not: "local branch not deleted",
    },
    "delete origin branch": {
      ok: "origin branch deleted",
      already: "origin branch already gone",
      not: "origin branch not deleted",
    },
  };

function label(f: Finding): string {
  // Only a merged PR's title is shown: anyone can title an open one.
  const title = f.state === "MERGED" && f.title ? ` (${f.title})` : "";
  return `#${f.number}${title}`;
}

function lineFor(f: Finding, steps: Step[], mode: "check" | "clean"): string {
  if (mode === "check") return `${label(f)} ${f.verdict}: ${f.reason}`;
  if (!steps.length) return `${label(f)}: left as is: ${f.reason}`;
  if (steps.every((s) => s.status === "skipped")) {
    return `${label(f)}: left as is: ${steps[0].detail}`;
  }
  const parts = steps.map((s) => {
    const p = PHRASES[s.step];
    if (s.status === "done") return p.ok;
    if (s.status === "already done") return p.already;
    return `${p.not} (${s.detail})`;
  });
  return `${label(f)}: ${parts.join(", ")}`;
}

function item(f: Finding, steps: Step[], mode: "check" | "clean"): Item {
  const { head: _head, ...rest } = f;
  return { ...rest, steps, line: lineFor(f, steps, mode) };
}

/** One line for all the PRs; "Nothing to clean up" for none. */
export function summarise(items: Item[], mode: "check" | "clean"): string {
  if (!items.length) return "Nothing to clean up";
  return items.map((i) => {
    if (mode === "check") return `#${i.number} ${i.verdict}`;
    if (!i.steps.length) return `#${i.number} left as is (${i.verdict})`;
    const ok = i.steps.filter((s) =>
      s.status === "done" || s.status === "already done"
    ).length;
    if (ok === i.steps.length) return `#${i.number} cleaned up`;
    return ok
      ? `#${i.number} partly cleaned up`
      : `#${i.number} not cleaned up`;
  }).join(", ");
}

const skipAll = (names: Step["step"][], detail: string): Step[] =>
  names.map((step) => ({ step, status: "skipped", detail }));

const CLEAN_STEPS: Step["step"][] = [
  "remove worktree",
  "delete local branch",
  "delete origin branch",
  "fast-forward main",
];
const PRIMARY_STEPS: Step["step"][] = [
  "switch to main",
  "fast-forward main",
  "delete local branch",
  "delete origin branch",
];

/**
 * Clean up what `inspect` found: each `clean` PR's worktree and branches, each
 * `primary` PR's main checkout and branches, then main once. Every other
 * verdict is left as is. Checks again before each step.
 */
export async function act(
  found: Inspection,
  runModel: RunModel,
): Promise<Item[]> {
  // A call that throws is that call failing, so one step fails and the rest
  // are still reported (and the result still written).
  const run: RunModel = (call) =>
    runModel(call).catch((e) => ({
      ok: false as const,
      error: { message: message(e) },
    }));
  const main = found.mainCheckout;
  const at = { repoPath: main };
  const short = (sha: string) => sha.slice(0, 7);

  let ff: Promise<Step> | undefined;
  const fastForward = () =>
    ff ??= (async (): Promise<Step> => {
      const step = "fast-forward main" as const;
      try {
        const primary = (await worktreesOf(run, main)).find((w) => w.primary);
        const branch = primary?.branch ?? "";
        if (!isMain(branch)) {
          return {
            step,
            status: "skipped",
            detail: `the main checkout is on ${
              branch || "no branch"
            }, not main`,
          };
        }
        if (!(await isClean(run, main))) {
          return {
            step,
            status: "skipped",
            detail:
              "the main checkout has uncommitted changes, so it was left " +
              "untouched",
          };
        }
        const res = await run({
          ...GIT,
          method: "pull",
          arguments: { ...at, remote: "origin", branch, ffOnly: true },
        });
        if (!res.ok) {
          // Only git refusing to fast-forward is a skip; a network, auth or
          // lock error is the step failing.
          return NO_FAST_FORWARD.test(res.error.message)
            ? {
              step,
              status: "skipped",
              detail: `${branch} can't fast-forward to origin/${branch}, so ` +
                `it was left as it is: ${oneLine(res.error.message, 120)}`,
            }
            : {
              step,
              status: "failed",
              detail: oneLine(res.error.message, 160),
            };
        }
        return res.resources[0]?.attributes?.alreadyUpToDate === true
          ? { step, status: "already done", detail: `${branch} was up to date` }
          : { step, status: "done", detail: `${branch} fast-forwarded` };
      } catch (e) {
        return { step, status: "failed", detail: message(e) };
      }
    })();

  const deleteLocal = async (f: Finding): Promise<Step> => {
    const step = "delete local branch" as const;
    const res = await run({
      ...GIT,
      method: "cleanup_delete_branch",
      arguments: { ...at, branch: f.branch },
    });
    if (!res.ok) {
      return {
        step,
        status: "failed",
        detail: oneLine(res.error.message, 160),
      };
    }
    return res.resources[0]?.attributes?.alreadyAbsent === true
      ? {
        step,
        status: "already done",
        detail: `${f.branch} was already deleted`,
      }
      : {
        step,
        status: "done",
        detail: `${f.branch} deleted with git branch -d`,
      };
  };

  // One ls-remote and one push: cleanup_delete_remote_branch finds a branch
  // already gone itself, and its lease on the PR's head refuses one that moved.
  const deleteOrigin = async (f: Finding): Promise<Step> => {
    const step = "delete origin branch" as const;
    const res = await run({
      ...GIT,
      method: "cleanup_delete_remote_branch",
      arguments: { ...at, branch: f.branch, expect: f.head },
    });
    if (!res.ok) {
      return /stale info/.test(res.error.message)
        ? {
          step,
          status: "skipped",
          detail: `origin's ${f.branch} has moved past #${f.number}'s head ` +
            `(${short(f.head)}), so it was kept`,
        }
        : { step, status: "failed", detail: oneLine(res.error.message, 160) };
    }
    return res.resources[0]?.attributes?.alreadyAbsent === true
      ? {
        step,
        status: "already done",
        detail: `origin's ${f.branch} was already deleted`,
      }
      : {
        step,
        status: "done",
        detail: `origin's ${f.branch} deleted at ${short(f.head)}`,
      };
  };

  /** Why `w` is no longer safe to act on, or "" if it still is. */
  const changed = async (
    f: Finding,
    w: Worktree,
    place: string,
  ): Promise<string> => {
    if (w.branch !== f.branch) {
      return `${place} is now on ${w.branch || "no branch"}`;
    }
    if (w.head !== f.head) {
      return `${place} is no longer at #${f.number}'s head (a new commit ` +
        "since the check), so it was left as is";
    }
    if (w.locked) return `${place} is now locked`;
    if (!(await isClean(run, w.path))) {
      return `${place} now has uncommitted changes, so it was left as is`;
    }
    return "";
  };

  /** The steps, and whether the PR acted (so main is fast-forwarded for it). */
  const cleanPr = async (
    f: Finding,
  ): Promise<{ steps: Step[]; acted: boolean }> => {
    const step = "remove worktree" as const;
    let w: Worktree | undefined;
    try {
      w = (await worktreesOf(run, main)).find((w) => w.path === f.worktree);
      if (w) {
        const why = await changed(f, w, `the worktree ${f.worktree}`);
        if (why) return { steps: skipAll(CLEAN_STEPS, why), acted: false };
      }
    } catch (e) {
      const why = `could not check again: ${message(e)}`;
      return { steps: skipAll(CLEAN_STEPS, why), acted: false };
    }
    let removed: Step;
    if (!w) {
      removed = {
        step,
        status: "already done",
        detail: "it was already removed",
      };
    } else {
      const res = await run({
        ...GIT,
        method: "remove_worktree",
        arguments: { ...at, path: f.worktree },
      });
      if (!res.ok) {
        const detail = oneLine(res.error.message, 160);
        return {
          steps: [
            { step, status: "failed", detail },
            ...skipAll(CLEAN_STEPS.slice(1), "the worktree was not removed"),
          ],
          acted: false,
        };
      }
      removed = res.resources[0]?.attributes?.alreadyAbsent === true
        ? { step, status: "already done", detail: "it was already removed" }
        : { step, status: "done", detail: `${f.worktree} removed` };
    }
    // The local branch goes first, while origin's branch is still there, so
    // `-d` accepts a squash-merged branch that tracks it. A refusal is
    // reported; origin's delete is leased on the head, so it still runs.
    const local = await deleteLocal(f);
    const origin = await deleteOrigin(f);
    return { steps: [removed, local, origin], acted: true };
  };

  const primaryPr = async (f: Finding): Promise<Step[]> => {
    const step = "switch to main" as const;
    try {
      const w = (await worktreesOf(run, main)).find((w) => w.primary);
      if (!w) return skipAll(PRIMARY_STEPS, "the main checkout was not found");
      const why = await changed(f, w, `the main checkout ${w.path}`);
      if (why) return skipAll(PRIMARY_STEPS, why);
    } catch (e) {
      return skipAll(PRIMARY_STEPS, `could not check again: ${message(e)}`);
    }
    // main, or master where the repo has no main (the spec's assumption).
    const listed = await run({
      ...GIT,
      method: "branch",
      arguments: { ...at, list: true },
    });
    const names =
      listed.ok && Array.isArray(listed.resources[0]?.attributes?.branches)
        ? (listed.resources[0].attributes.branches as unknown[]).map((b) =>
          str(b).replace(/^[*+] /, "")
        )
        : [];
    const trunk = ["main", "master"].find((b) => names.includes(b));
    const res = trunk
      ? await run({
        ...GIT,
        method: "branch",
        arguments: { ...at, name: trunk },
      })
      : {
        ok: false as const,
        error: {
          message: listed.ok
            ? "the repo has no main or master branch"
            : listed.error.message,
        },
      };
    if (!res.ok) {
      return [
        { step, status: "failed", detail: oneLine(res.error.message, 160) },
        ...skipAll(
          PRIMARY_STEPS.slice(1),
          "the main checkout was not switched",
        ),
      ];
    }
    const switched: Step = {
      step,
      status: "done",
      detail: `${main} on ${trunk}`,
    };
    const pulled = await fastForward();
    return [switched, pulled, await deleteLocal(f), await deleteOrigin(f)];
  };

  const done: Array<{ steps: Step[]; acted: boolean }> = [];
  for (const f of found.findings) {
    if (f.verdict === "clean") done.push(await cleanPr(f));
    else if (f.verdict === "primary") {
      done.push({ steps: await primaryPr(f), acted: false });
    } else done.push({ steps: [], acted: false });
  }
  // Main is fast-forwarded once, after every clean PR has acted.
  const items: Item[] = [];
  for (const [i, f] of found.findings.entries()) {
    const { steps, acted } = done[i];
    items.push(
      item(f, acted ? [...steps, await fastForward()] : steps, "clean"),
    );
  }
  return items;
}

/** `check`: what each PR's verdict is. Only reads. */
export async function check(
  args: { pr: number; prs: string },
  run: RunModel,
): Promise<Item[]> {
  const found = await inspect(prNumbers(args.pr, args.prs), run);
  return found.findings.map((f) => item(f, [], "check"));
}

/** `clean`: check, then clean up each PR that is safe to. */
export async function clean(
  args: { pr: number; prs: string },
  run: RunModel,
): Promise<Item[]> {
  const found = await inspect(prNumbers(args.pr, args.prs), run);
  return act(found, run);
}
