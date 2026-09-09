#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { disconnectDatabase } from "../db/client.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";

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

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}
