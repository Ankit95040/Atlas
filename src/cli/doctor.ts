import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config/index.js";
import { checkDatabaseConnection } from "../db/client.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

async function commandVersion(binary: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(binary, args, { timeout: 10_000 });
  const output = `${stdout}${stderr}`.trim();
  if (output.length === 0) {
    throw new Error(`${binary} produced no output`);
  }
  return output.split("\n")[0] ?? output;
}

export function checkNodeVersion(version: string = process.version): DoctorCheck {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return { name: "Node.js", ok: false, detail: `unparsable version: ${version}` };
  }
  const major = Number(match[1]);
  if (major >= 20) {
    return { name: "Node.js", ok: true, detail: version };
  }
  return { name: "Node.js", ok: false, detail: `${version} (requires >= v20)` };
}

export async function checkGit(gitBinary = "git"): Promise<DoctorCheck> {
  try {
    const detail = await commandVersion(gitBinary, ["--version"]);
    return { name: "Git", ok: true, detail };
  } catch (error) {
    return { name: "Git", ok: false, detail: (error as Error).message };
  }
}

export async function checkDocker(dockerBinary = "docker"): Promise<DoctorCheck> {
  try {
    const detail = await commandVersion(dockerBinary, ["--version"]);
    return { name: "Docker", ok: true, detail };
  } catch (error) {
    return { name: "Docker", ok: false, detail: (error as Error).message };
  }
}

export function checkConfiguration(env: NodeJS.ProcessEnv = process.env): DoctorCheck {
  try {
    const config = loadConfig(env);
    return { name: "Configuration", ok: true, detail: `env=${config.nodeEnv} db=${config.databaseUrl}` };
  } catch (error) {
    return { name: "Configuration", ok: false, detail: (error as Error).message };
  }
}

export async function checkDatabase(): Promise<DoctorCheck> {
  try {
    await checkDatabaseConnection();
    return { name: "Database", ok: true, detail: "SQLite/Prisma connectivity OK" };
  } catch (error) {
    return { name: "Database", ok: false, detail: (error as Error).message };
  }
}

export async function runDoctor(): Promise<DoctorResult> {
  const config = loadConfigSafe();
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    await checkGit(config?.gitBinary ?? "git"),
    await checkDocker(config?.dockerBinary ?? "docker"),
    checkConfiguration(),
    await checkDatabase(),
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

function loadConfigSafe(): { gitBinary: string; dockerBinary: string } | undefined {
  try {
    const config = loadConfig();
    return { gitBinary: config.gitBinary, dockerBinary: config.dockerBinary };
  } catch {
    return undefined;
  }
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = result.checks.map((check) => `${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  lines.unshift(result.ok ? "Atlas doctor: all checks passed" : "Atlas doctor: some checks failed");
  return lines.join("\n");
}
