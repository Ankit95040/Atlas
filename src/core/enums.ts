import {
  ApprovalStatus,
  ArtifactType,
  EventType,
  FeatureStatus,
  ProjectStatus,
  TaskStatus,
  TestRunStatus,
  WorkerStatus,
  WorkspaceStatus,
} from "@prisma/client";

// Re-export the Prisma-backed lifecycle enums as the canonical domain vocabulary.
// Transition rules for these live in ./transitions.js; input validation in ./inputs.js.
export {
  ApprovalStatus,
  ArtifactType,
  EventType,
  FeatureStatus,
  ProjectStatus,
  TaskStatus,
  TestRunStatus,
  WorkerStatus,
  WorkspaceStatus,
};
