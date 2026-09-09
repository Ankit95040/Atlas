import { afterAll, afterEach } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";

type Delegate = { deleteMany: (args: { where: { id: string } }) => Promise<unknown> };

const delegates: Record<string, Delegate> = {
  event: getPrismaClient().event,
  approval: getPrismaClient().approval,
  testRun: getPrismaClient().testRun,
  commit: getPrismaClient().commit,
  artifact: getPrismaClient().artifact,
  contract: getPrismaClient().contract,
  taskDependency: getPrismaClient().taskDependency,
  workspace: getPrismaClient().workspace,
  worker: getPrismaClient().worker,
  task: getPrismaClient().task,
  feature: getPrismaClient().feature,
  repository: getPrismaClient().repository,
  project: getPrismaClient().project,
};

// Creation-order registry; cleanup deletes in reverse so children go before parents.
// (TaskDependency edges cascade with their task; everything else is restrictive.)
const tracked: Array<{ model: string; id: string }> = [];

export function track(model: string, id: string): string {
  tracked.push({ model, id });
  return id;
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

afterEach(async () => {
  for (const { model, id } of tracked.splice(0).reverse()) {
    await delegates[model]?.deleteMany({ where: { id } });
  }
});

afterAll(async () => {
  await disconnectDatabase();
});
