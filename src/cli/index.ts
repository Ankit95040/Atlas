#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { disconnectDatabase } from "../db/client.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";
import { runInitCommand } from "./init.js";
import { EXIT_USAGE, writeCommandError, writeCommandOutput } from "./output.js";
import { runPlanCommand } from "./plan.js";
import { runRecoverTaskCommand } from "./recover.js";
import { runRunCommand } from "./run-command.js";
import { runTaskTransitionCommand } from "./transition.js";
import {
  runClaimsCommand,
  runDiagnoseCommand,
  runHistoryCommand,
  runShowRunCommand,
  runShowTaskCommand,
  runShowWorkerCommand,
  runStatusCommand,
} from "./show.js";

const ATLAS_VERSION = "0.1.0";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("atlas")
    .description("Atlas V0.1 — headless AI software engineering orchestration engine (foundation)")
    .version(ATLAS_VERSION, "-V, --version", "output the version number");

  program
    .command("doctor")
    .description("Check Node.js, Git, Docker, Atlas configuration, and database connectivity")
    .action(async () => {
      const result = await runDoctor();
      console.log(formatDoctorResult(result));
      await disconnectDatabase();
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  program
    .command("init")
    .description("Create the prerequisite project, repository, and feature rows for a Git checkout (first step before plan)")
    .requiredOption("--name <name>", "Project name")
    .requiredOption("--repo-path <path>", "Path to the Git checkout Atlas will orchestrate")
    .requiredOption("--feature-title <title>", "Title of the first feature")
    .option("--description <text>", "Project description")
    .option("--feature-description <text>", "Feature description")
    .option("--remote-url <url>", "Repository remote URL")
    .option("--default-branch <branch>", "Repository default branch")
    .option("--json", "Machine-readable output")
    .action(
      async (opts: {
        name: string;
        repoPath: string;
        featureTitle: string;
        description?: string;
        featureDescription?: string;
        remoteUrl?: string;
        defaultBranch?: string;
        json?: boolean;
      }) => {
        try {
          const output = await runInitCommand({
            name: opts.name,
            repoPath: opts.repoPath,
            featureTitle: opts.featureTitle,
            ...(opts.description !== undefined ? { description: opts.description } : {}),
            ...(opts.featureDescription !== undefined ? { featureDescription: opts.featureDescription } : {}),
            ...(opts.remoteUrl !== undefined ? { remoteUrl: opts.remoteUrl } : {}),
            ...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
          });
          writeCommandOutput(output, opts.json === true);
          await disconnectDatabase();
          process.exitCode = output.exitCode;
        } catch (error) {
          writeCommandError(error, opts.json === true);
          await disconnectDatabase();
          process.exitCode = EXIT_USAGE;
        }
      },
    );

  const task = program.command("task").description("Operator-driven task state management");

  task
    .command("transition <task-id>")
    .description("Move a task along one allowed state-machine edge (stuck-state exit; records actor and reason)")
    .requiredOption("--to <status>", "Target task status (must be a directly reachable edge)")
    .requiredOption("--actor <name>", "Human author confirming the transition")
    .requiredOption("--reason <text>", "Reason recorded on the TASK_TRANSITIONED event")
    .option("--json", "Machine-readable output")
    .action(async (taskId: string, opts: { to: string; actor: string; reason: string; json?: boolean }) => {
      try {
        const output = await runTaskTransitionCommand({
          taskId,
          to: opts.to,
          actor: opts.actor,
          reason: opts.reason,
        });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("plan")
    .description("Validate a proposal file, persist its tasks, and preview the schedule (never executes)")
    .requiredOption("--feature <id>", "Feature ID the proposal applies to")
    .requiredOption("--proposal <file>", "Path to the untrusted proposal JSON file")
    .option("--approve", "Decide the plan approval APPROVED in this invocation (requires --actor)")
    .option("--actor <name>", "Human author recorded on the approval decision")
    .option("--max-concurrency <n>", "Width used for the schedule preview", "4")
    .option("--json", "Machine-readable output")
    .action(async (opts: { feature: string; proposal: string; approve?: boolean; actor?: string; maxConcurrency?: string; json?: boolean }) => {
      try {
        const output = await runPlanCommand({
          featureId: opts.feature,
          proposal: opts.proposal,
          ...(opts.approve === true ? { approve: true as const } : {}),
          ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
          ...(opts.maxConcurrency !== undefined ? { maxConcurrency: Number(opts.maxConcurrency) } : {}),
        });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("status")
    .description("Read-only overview: task/worker states, recent events, visible failures")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const output = await runStatusCommand({});
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  const show = program.command("show").description("Read-only inspection of runs, tasks, and workers");

  show
    .command("run <run-id>")
    .description("Show a run scope (a feature execution): tasks, workers, integration, timing, failures")
    .option("--json", "Machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      try {
        const output = await runShowRunCommand({ runId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  show
    .command("task <task-id>")
    .description("Show a task: status, dependencies, claims, assignment, evidence, timing")
    .option("--json", "Machine-readable output")
    .action(async (taskId: string, opts: { json?: boolean }) => {
      try {
        const output = await runShowTaskCommand({ taskId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  show
    .command("worker <worker-id>")
    .description("Show a worker: assignment, workspace, execution, failures, timing")
    .option("--json", "Machine-readable output")
    .action(async (workerId: string, opts: { json?: boolean }) => {
      try {
        const output = await runShowWorkerCommand({ workerId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("history <run-id>")
    .description("Chronological event history for a run scope (a feature execution)")
    .option("--json", "Machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      try {
        const output = await runHistoryCommand({ runId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("claims <run-id>")
    .description("Task/resource claims for a run scope with pairwise overlaps")
    .option("--json", "Machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      try {
        const output = await runClaimsCommand({ runId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("diagnose <run-id>")
    .description("Failure analysis for a run scope from persisted structured evidence")
    .option("--json", "Machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      try {
        const output = await runDiagnoseCommand({ runId });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  const recover = program
    .command("recover")
    .description("Release stranded assignments (explicit human-confirmed recovery only)");

  recover
    .command("task <task-id>")
    .description("Release a stranded CLAIMED/ASSIGNED assignment so the task is schedulable again")
    .requiredOption("--actor <name>", "Human author confirming the recovery")
    .option("--json", "Machine-readable output")
    .action(async (taskId: string, opts: { actor: string; json?: boolean }) => {
      try {
        const output = await runRecoverTaskCommand({ taskId, actor: opts.actor });
        writeCommandOutput(output, opts.json === true);
        await disconnectDatabase();
        process.exitCode = output.exitCode;
      } catch (error) {
        writeCommandError(error, opts.json === true);
        await disconnectDatabase();
        process.exitCode = EXIT_USAGE;
      }
    });

  program
    .command("run")
    .description("Execute approved plans through the wave loop (requires plan approval + --approve-merge)")
    .requiredOption("--feature <id>", "Feature ID to execute")
    .requiredOption("--repository <id>", "Repository ID holding the working tree")
    .requiredOption("--plan-approval <id>", "APPROVED plan approval ID for this feature")
    .requiredOption("--actor <name>", "Human author recorded on approval decisions")
    .requiredOption("--agent <executable>", "Worker executable (argv-only, no shell)")
    .option("--agent-arg <arg>", "Repeatable argument appended to the worker argv", collectRepeatable, [])
    .option("--agent-timeout-ms <ms>", "Worker subprocess timeout")
    .option("--agent-env <name>", "Repeatable host env var name forwarded to workers", collectRepeatable, [])
    .option("--approve-merge", "Explicitly approve merging verified work (recorded via the Approval API)")
    .option("--base <sha>", "Base commit (defaults to repository HEAD)")
    .option("--max-concurrency <n>", "Wave width bound", "4")
    .option("--test-command <executable>", "Explicit test executable (defaults to package.json scripts.test)")
    .option("--test-arg <arg>", "Repeatable argument appended to the test argv", collectRepeatable, [])
    .option("--train-branch <branch>", "Integration branch (defaults under atlas/cli/)")
    .option("--train-path <path>", "Train worktree destination (defaults under .atlas/)")
    .option("--workspace-root <path>", "Worker workspace root (defaults under .atlas/)")
    .option("--json", "Machine-readable output")
    .action(
      async (opts: {
        feature: string;
        repository: string;
        planApproval: string;
        actor: string;
        agent: string;
        agentArg: string[];
        agentTimeoutMs?: string;
        agentEnv: string[];
        approveMerge?: boolean;
        base?: string;
        maxConcurrency?: string;
        testCommand?: string;
        testArg: string[];
        trainBranch?: string;
        trainPath?: string;
        workspaceRoot?: string;
        json?: boolean;
      }) => {
        try {
          const output = await runRunCommand({
            featureId: opts.feature,
            repositoryId: opts.repository,
            planApproval: opts.planApproval,
            actor: opts.actor,
            agent: opts.agent,
            agentArg: opts.agentArg,
            ...(opts.approveMerge === true ? { approveMerge: true as const } : {}),
            ...(opts.agentTimeoutMs !== undefined ? { agentTimeoutMs: Number(opts.agentTimeoutMs) } : {}),
            ...(opts.agentEnv.length > 0 ? { agentEnv: opts.agentEnv } : {}),
            ...(opts.base !== undefined ? { base: opts.base } : {}),
            ...(opts.maxConcurrency !== undefined ? { maxConcurrency: Number(opts.maxConcurrency) } : {}),
            ...(opts.testCommand !== undefined ? { testCommand: opts.testCommand } : {}),
            ...(opts.testArg.length > 0 ? { testArg: opts.testArg } : {}),
            ...(opts.trainBranch !== undefined ? { trainBranch: opts.trainBranch } : {}),
            ...(opts.trainPath !== undefined ? { trainPath: opts.trainPath } : {}),
            ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
          });
          writeCommandOutput(output, opts.json === true);
          await disconnectDatabase();
          process.exitCode = output.exitCode;
        } catch (error) {
          writeCommandError(error, opts.json === true);
          await disconnectDatabase();
          process.exitCode = EXIT_USAGE;
        }
      },
    );

  return program;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}
