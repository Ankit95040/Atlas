#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { disconnectDatabase } from "../db/client.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";
import { EXIT_USAGE, writeCommandError, writeCommandOutput } from "./output.js";
import { runPlanCommand } from "./plan.js";
import { runRunCommand } from "./run-command.js";

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
