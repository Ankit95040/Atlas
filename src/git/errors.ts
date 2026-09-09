import { DomainError } from "../core/errors.js";

/** Every git-layer failure is a DomainError with a stable code. */

export class GitCommandError extends DomainError {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(args: readonly string[], cwd: string, exitCode: number | null, stdout: string, stderr: string) {
    const detail = firstLine(stderr) ?? firstLine(stdout) ?? "unknown git failure";
    super("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed in ${cwd} (exit ${exitCode ?? "n/a"}): ${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class GitNotInstalledError extends DomainError {
  constructor() {
    super("GIT_NOT_INSTALLED", "git executable not found on PATH; Git CLI is a required Atlas dependency");
    this.name = "GitNotInstalledError";
  }
}

export class NotGitRepositoryError extends DomainError {
  constructor(path: string) {
    super("NOT_GIT_REPOSITORY", `not a git repository: ${path}`);
    this.name = "NotGitRepositoryError";
  }
}

export class WorktreeAlreadyExistsError extends DomainError {
  constructor(path: string) {
    super("WORKTREE_ALREADY_EXISTS", `worktree already registered or destination in use: ${path}`);
    this.name = "WorktreeAlreadyExistsError";
  }
}

export class WorktreeNotFoundError extends DomainError {
  constructor(path: string) {
    super("WORKTREE_NOT_FOUND", `no registered worktree at: ${path}`);
    this.name = "WorktreeNotFoundError";
  }
}

export class InvalidWorktreePathError extends DomainError {
  constructor(reason: string) {
    super("INVALID_WORKTREE_PATH", reason);
    this.name = "InvalidWorktreePathError";
  }
}

export class UnsafeWorktreeOperationError extends DomainError {
  constructor(reason: string) {
    super("UNSAFE_WORKTREE_OPERATION", reason);
    this.name = "UnsafeWorktreeOperationError";
  }
}

export class InvalidBranchNameError extends DomainError {
  constructor(name: string, reason: string) {
    super("INVALID_BRANCH_NAME", `invalid branch name "${name}": ${reason}`);
    this.name = "InvalidBranchNameError";
  }
}

function firstLine(output: string): string | null {
  const line = output.split("\n")[0]?.trim();
  return line !== undefined && line.length > 0 ? line : null;
}
