export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunGitOptions {
  /** Directory Git runs in. Always explicit — never inherited ambiently. */
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface FileStatus {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface RepositoryStatus extends FileStatus {
  readonly clean: boolean;
}

export interface WorktreeInfo {
  /** Absolute path, exactly as reported by `git worktree list`. */
  readonly path: string;
  /** Checked-out branch, or null when detached (or bare). */
  readonly branch: string | null;
  /** Full HEAD commit SHA. */
  readonly commit: string;
  /** True for the first (main) entry in `git worktree list`. */
  readonly isMain: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface CreateWorktreeInput {
  /** Any path inside the repository (root is resolved from it). */
  readonly repoPath: string;
  /** Destination directory for the new isolated worktree. */
  readonly path: string;
  /** New branch to create and check out (validated before Git sees it). */
  readonly branch: string;
  /** Base ref/commit to start from. Defaults to HEAD. */
  readonly base?: string;
}

export interface WorktreeOperationOptions {
  readonly timeoutMs?: number;
  readonly force?: boolean;
}
