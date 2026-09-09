/** Small explicit vocabulary for repository resources. Kinds, not instances. */
export type ResourceKind =
  | "FILE"
  | "DIRECTORY"
  | "CONFIG"
  | "SCHEMA"
  | "MIGRATION"
  | "PACKAGE_MANIFEST"
  | "LOCKFILE"
  | "TEST"
  | "SOURCE";

export interface ResourceEntry {
  /**
   * Stable canonical identifier: repository-relative POSIX path, no trailing
   * slash, no leading `./`. Identical for the same repo on any machine.
   * Never an absolute path — absolute paths are machine-specific.
   */
  readonly id: string;
  readonly kind: ResourceKind;
}

export interface RepositoryAnalysis {
  readonly repositoryRoot: string;
  /** Full HEAD commit SHA the analysis is pinned to. Analyses are not timeless. */
  readonly analyzedCommit: string;
  readonly resourceCount: number;
  /** Sorted by id in code-unit order — never filesystem traversal order. */
  readonly resources: readonly ResourceEntry[];
}
