import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { recordArtifact } from "../core/service.js";
import { validateRepository } from "../git/index.js";
import { compareClaimSets, resourceOverlaps } from "../claims/conflicts.js";
import { getTaskClaims } from "../claims/service.js";
import type { NormalizedClaim } from "../claims/types.js";
import { TaskGraph } from "../dag/graph.js";
import { TriageError } from "./errors.js";
import { collectReplayEvidence, diffBranchFiles, resolveTaskBranch } from "./evidence.js";
import {
  CLASSIFICATION_ORDER,
  TriageIntegrationHaltInputSchema,
  TriageReportSchema,
  isFailureStatus,
  type ClaimOverlap,
  type DependencyLink,
  type FileOwnership,
  type SemanticFlag,
  type TriageAction,
  type TriageClassification,
  type TriageReport,
} from "./types.js";

export interface ClassifyTriageFindingsInput {
  readonly conflictFiles: readonly string[];
  readonly ownership: ReadonlyArray<{ file: string; owners: readonly string[] }>;
  readonly claimOverlap: ReadonlyArray<{ taskA: string; taskB: string }>;
  readonly dependencyLinks: readonly unknown[];
  readonly semanticFlags: readonly unknown[];
  /**
   * Task IDs the merge train flagged as empty merges (M19.3). Optional so
   * previously constructed inputs still typecheck; absent means no flag.
   */
  readonly emptyMerges?: readonly string[];
}

const ACTION_FOR: Record<TriageClassification, readonly TriageAction[]> = {
  GIT_CONFLICT: ["review-conflicting-files", "revise-one-implementation"],
  CLAIM_CONFLICT: ["revise-claims", "split-shared-resources"],
  EMPTY_MERGE: ["inspect-train-worktree", "replan-or-abandon"],
  DEPENDENCY_ORDERING: ["review-task-ordering", "add-dependency-edge"],
  SEMANTIC_RISK: ["human-review-required"],
  UNKNOWN: ["inspect-train-worktree", "replan-or-abandon"],
};

/**
 * Pure classifier: evidence in, classifications + recommended actions out.
 * No Git, no DB, no LLM — the same function the pipeline and the unit tests
 * share, so the matrix (tests 3/4/6/7/8) is verified without fixtures.
 */
export function classifyTriageFindings(input: ClassifyTriageFindingsInput): {
  classifications: TriageClassification[];
  recommendedActions: TriageAction[];
} {
  const found = new Set<TriageClassification>();
  if (input.conflictFiles.length > 0) {
    found.add("GIT_CONFLICT");
  }
  if ((input.emptyMerges ?? []).length > 0) {
    found.add("EMPTY_MERGE");
  }
  if (input.claimOverlap.length > 0) {
    found.add("CLAIM_CONFLICT");
  }
  if (input.dependencyLinks.length > 0) {
    found.add("DEPENDENCY_ORDERING");
  }
  if (input.semanticFlags.length > 0) {
    found.add("SEMANTIC_RISK");
  }
  if (found.size === 0 || input.ownership.some((entry) => entry.owners.length === 0)) {
    found.add("UNKNOWN");
  }
  const classifications = CLASSIFICATION_ORDER.filter((code) => found.has(code));
  const actions = [...new Set(classifications.flatMap((code) => ACTION_FOR[code]))].sort();
  return { classifications, recommendedActions: actions };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Deterministic integration-triage over a halted merge train. Read-only:
 * collects Git evidence (branch diffs + a throwaway replay worktree that is
 * always removed), compares declared claims with the existing M5 engine,
 * reads dependency edges through the existing M6 graph, and returns a
 * structured, JSON-serializable report. Records one ANALYSIS_REPORT artifact
 * pointing at the halt; creates no other rows, modifies no branches, resolves
 * nothing. Evidence-collection failures degrade to UNKNOWN findings — a
 * triage failure never masks the merge failure.
 */
export async function triageIntegrationHalt(
  raw: unknown,
  db: PrismaClient = getPrismaClient(),
): Promise<TriageReport> {
  const input = TriageIntegrationHaltInputSchema.parse(raw);
  const notes: string[] = [];

  const repository = await db.repository.findUnique({ where: { id: input.repositoryId } });
  if (repository === null) {
    throw new TriageError(`unknown repository: ${input.repositoryId}`);
  }
  const root = await validateRepository(repository.localPath);

  const halted = input.items.find((item) => isFailureStatus(item.status));
  if (halted === undefined) {
    throw new TriageError("triage needs a halted train item (CONFLICT, MERGE_FAILED, TESTS_FAILED, or VERIFICATION_FAILED)");
  }
  if (halted.reason !== undefined) {
    notes.push(`train halt reason: ${halted.reason}`);
  }
  const integrated = input.items.filter((item) => item.status === "INTEGRATED");

  // Resolve branches through worker → workspace records. Never guessed.
  const branchOf = new Map<string, string>();
  const haltedBranch = await resolveTaskBranch(db, root, halted.taskId);
  if ("branch" in haltedBranch) {
    branchOf.set(halted.taskId, haltedBranch.branch);
  } else {
    notes.push(haltedBranch.unknown);
  }
  for (const item of integrated) {
    const resolved = await resolveTaskBranch(db, root, item.taskId);
    if ("branch" in resolved) {
      branchOf.set(item.taskId, resolved.branch);
    } else {
      notes.push(resolved.unknown);
    }
  }

  // Git-confirmed conflict files via throwaway replay (CONFLICT/MERGE_FAILED
  // only — the aborted original can no longer answer).
  let conflictFiles: string[] = [];
  if ((halted.status === "CONFLICT" || halted.status === "MERGE_FAILED") && branchOf.has(halted.taskId)) {
    const replay = await collectReplayEvidence({
      repoRoot: root,
      finalCommit: input.finalCommit,
      haltedBranch: branchOf.get(halted.taskId) as string,
      haltedTaskId: halted.taskId,
      scratchParent: input.scratchParent,
    });
    conflictFiles = replay.conflictFiles;
    notes.push(...replay.notes);
  } else if (halted.status === "TESTS_FAILED" || halted.status === "VERIFICATION_FAILED") {
    notes.push(`replay skipped for ${halted.status}: no textual conflict is claimed`);
  } else {
    notes.push("replay skipped: halted branch could not be resolved");
  }

  // Per-branch changed files (read-only diffs; per-branch degrade to unknown).
  const filesOf = new Map<string, string[]>();
  for (const [taskId, branch] of branchOf) {
    try {
      filesOf.set(taskId, await diffBranchFiles(root, input.baseCommit, branch));
    } catch (error) {
      notes.push(`could not diff branch ${branch} for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Ownership: exact file match against proven branch diffs.
  const ownership: FileOwnership[] = conflictFiles.map((file) => {
    const owners = integrated
      .map((item) => item.taskId)
      .filter((taskId) => filesOf.get(taskId)?.includes(file) === true)
      .sort();
    return { file, owners, unknownOwner: owners.length === 0, coveringClaims: [] };
  });

  // Declared claims for the halted task, owners, and (for non-textual halts)
  // every integrated task — always via the existing claim APIs.
  const claimScope = new Set<string>([halted.taskId]);
  for (const entry of ownership) {
    for (const owner of entry.owners) {
      claimScope.add(owner);
    }
  }
  if (conflictFiles.length === 0) {
    for (const item of integrated) {
      claimScope.add(item.taskId);
    }
  }
  const claimsOf = new Map<string, NormalizedClaim[]>();
  for (const taskId of [...claimScope].sort()) {
    try {
      claimsOf.set(taskId, await getTaskClaims(taskId, db));
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      notes.push(`could not load claims for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      claimsOf.set(taskId, []);
    }
  }

  // Per-file covering claims (which declared claims cover each conflict file).
  const ownershipWithClaims: FileOwnership[] = ownership.map((entry) => {
    const covering = [...claimScope]
      .sort()
      .flatMap((taskId) =>
        (claimsOf.get(taskId) ?? [])
          .filter((claim) => resourceOverlaps(entry.file, claim.resourceId))
          .map((claim) => ({ taskId, resourceId: claim.resourceId, access: claim.access })),
      );
    return { ...entry, coveringClaims: covering };
  });

  // Pairwise claim comparison over involved tasks (existing M5 engine).
  const involved = sortedUnique(claimScope);
  const claimOverlap: ClaimOverlap[] = [];
  for (let i = 0; i < involved.length; i += 1) {
    for (let j = i + 1; j < involved.length; j += 1) {
      const taskA = involved[i] as string;
      const taskB = involved[j] as string;
      const comparison = compareClaimSets(claimsOf.get(taskA) ?? [], claimsOf.get(taskB) ?? []);
      if (comparison.status === "CONFLICT") {
        claimOverlap.push({
          taskA,
          taskB,
          details: comparison.conflicts.map((detail) => ({
            resourceA: detail.resourceA,
            resourceB: detail.resourceB,
            accessA: detail.accessA,
            accessB: detail.accessB,
            kind: detail.kind,
          })),
        });
      }
    }
  }

  // Dependency links through the existing M6 graph (direction preserved).
  const graph = new TaskGraph();
  for (const taskId of involved) {
    const task = await db.task.findUnique({ where: { id: taskId } });
    if (task === null) {
      throw new NotFoundError("Task", taskId);
    }
    graph.addTask({ id: task.id, status: task.status, claims: claimsOf.get(taskId) ?? [] });
  }
  const edgeRows = await db.taskDependency.findMany({ where: { taskId: { in: involved } } });
  for (const row of edgeRows.sort((a, b) => (a.taskId === b.taskId ? (a.dependsOnTaskId < b.dependsOnTaskId ? -1 : 1) : a.taskId < b.taskId ? -1 : 1))) {
    if (involved.includes(row.dependsOnTaskId)) {
      graph.addDependency(row.taskId, row.dependsOnTaskId);
    }
  }
  const dependencyLinks: DependencyLink[] = [];
  for (const dep of graph.getDependencies(halted.taskId)) {
    if (involved.includes(dep) && dep !== halted.taskId) {
      dependencyLinks.push({ taskId: halted.taskId, dependsOnTaskId: dep, direction: "halted-waits-for-owner" });
    }
  }
  for (const dep of graph.getDependents(halted.taskId)) {
    if (involved.includes(dep)) {
      dependencyLinks.push({ taskId: dep, dependsOnTaskId: halted.taskId, direction: "owner-waits-for-halted" });
    }
  }
  dependencyLinks.sort((a, b) => (a.taskId === b.taskId ? (a.dependsOnTaskId < b.dependsOnTaskId ? -1 : 1) : a.taskId < b.taskId ? -1 : 1));

  // Semantic-risk flags: review signals with explicit notProven markers.
  const semanticFlags: SemanticFlag[] = [];
  for (const overlap of claimOverlap) {
    const disclosed = overlap.details.some(
      (detail) =>
        conflictFiles.some((file) => resourceOverlaps(file, detail.resourceA) || resourceOverlaps(file, detail.resourceB)),
    );
    if (!disclosed) {
      semanticFlags.push({
        kind: "SHARED_WRITE_WITHOUT_TEXTUAL_CONFLICT",
        detail: `tasks ${overlap.taskA} and ${overlap.taskB} hold overlapping write claims with no Git-confirmed textual conflict; shared-resource interaction cannot be ruled out`,
        tasks: [overlap.taskA, overlap.taskB].sort(),
        notProven: true as const,
      });
    }
  }
  if (halted.status === "TESTS_FAILED") {
    let exitPart = "unknown exit";
    if (halted.testRunId !== undefined) {
      const testRun = await db.testRun.findUnique({ where: { id: halted.testRunId } });
      exitPart = testRun?.exitCode === null || testRun?.exitCode === undefined ? "unknown exit" : `exit ${testRun.exitCode}`;
    }
    semanticFlags.push({
      kind: "CUMULATIVE_TESTS_FAILED",
      detail: `cumulative train tests failed after clean merges (${exitPart}); a behavioral interaction between integrated tasks is possible but unproven`,
      tasks: sortedUnique([halted.taskId, ...integrated.map((item) => item.taskId)]),
      notProven: true as const,
    });
  }
  semanticFlags.sort((a, b) => (a.kind === b.kind ? (a.detail < b.detail ? -1 : 1) : a.kind < b.kind ? -1 : 1));

  const { classifications, recommendedActions } = classifyTriageFindings({
    conflictFiles,
    ownership: ownershipWithClaims,
    claimOverlap,
    dependencyLinks,
    semanticFlags,
    emptyMerges: input.items.filter((item) => item.emptyMerge === true).map((item) => item.taskId),
  });

  const mergeCommits = integrated
    .map((item) => item.mergeCommit)
    .filter((sha): sha is string => sha !== undefined)
    .sort();
  const unsigned = {
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    finalCommit: input.finalCommit,
    haltedTaskId: halted.taskId,
    haltedStatus: halted.status,
    conflictFiles,
    ownership: ownershipWithClaims,
    claimOverlap,
    dependencyLinks,
    semanticFlags,
    classifications,
    recommendedActions,
    evidenceRefs: { artifactId: "pending", mergeCommits },
    collectionNotes: [...notes].sort(),
  };
  const contentHash = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  const artifact = await recordArtifact(
    {
      taskId: halted.taskId,
      type: "ANALYSIS_REPORT",
      label: `triage halted=${halted.taskId} ${classifications.join("+")} files=${conflictFiles.length}`,
      contentHash,
    },
    db,
  );
  const report = { ...unsigned, evidenceRefs: { artifactId: artifact.id, mergeCommits } };
  return TriageReportSchema.parse(report);
}
