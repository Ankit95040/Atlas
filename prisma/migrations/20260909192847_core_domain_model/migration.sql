-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "remoteUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Feature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "resourceClaims" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Worker_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT,
    "path" TEXT NOT NULL,
    "branch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "location" TEXT,
    "contentHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "title" TEXT,
    "requirements" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contract_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "artifactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "name" TEXT,
    "metadata" TEXT,
    "exitCode" INTEGER,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TestRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TestRun_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Commit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "taskId" TEXT,
    "workspaceId" TEXT,
    "sha" TEXT NOT NULL,
    "branch" TEXT,
    "subject" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Commit_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Commit_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Commit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "projectId" TEXT,
    "featureId" TEXT,
    "taskId" TEXT,
    "actor" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Event_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Event_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "actor" TEXT,
    "context" TEXT,
    "note" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Approval_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "repoPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("createdAt", "id", "name", "repoPath", "updatedAt") SELECT "createdAt", "id", "name", "repoPath", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Repository_projectId_idx" ON "Repository"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_projectId_name_key" ON "Repository"("projectId", "name");

-- CreateIndex
CREATE INDEX "Feature_projectId_idx" ON "Feature"("projectId");

-- CreateIndex
CREATE INDEX "Task_featureId_idx" ON "Task"("featureId");

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON "TaskDependency"("dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnTaskId_key" ON "TaskDependency"("taskId", "dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_taskId_key" ON "Worker"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_workerId_key" ON "Workspace"("workerId");

-- CreateIndex
CREATE INDEX "Artifact_taskId_idx" ON "Artifact"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_taskId_key" ON "Contract"("taskId");

-- CreateIndex
CREATE INDEX "TestRun_taskId_idx" ON "TestRun"("taskId");

-- CreateIndex
CREATE INDEX "Commit_taskId_idx" ON "Commit"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Commit_repositoryId_sha_key" ON "Commit"("repositoryId", "sha");

-- CreateIndex
CREATE INDEX "Event_projectId_idx" ON "Event"("projectId");

-- CreateIndex
CREATE INDEX "Event_taskId_idx" ON "Event"("taskId");

-- CreateIndex
CREATE INDEX "Approval_featureId_idx" ON "Approval"("featureId");

-- CreateIndex
CREATE INDEX "Approval_taskId_idx" ON "Approval"("taskId");
