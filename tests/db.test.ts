import { afterAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, disconnectDatabase, getPrismaClient } from "../src/db/client.js";

describe("database connectivity", () => {
  afterAll(async () => {
    await disconnectDatabase();
  });

  it("connects to SQLite via Prisma", async () => {
    await expect(checkDatabaseConnection()).resolves.toBe(true);
  });

  it("performs a Project roundtrip without storing source code", async () => {
    const prisma = getPrismaClient();
    const name = `atlas-foundation-test-${Date.now()}`;
    const created = await prisma.project.create({
      data: { name, repoPath: "/tmp/atlas-test-repo" },
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);

    const found = await prisma.project.findUnique({ where: { id: created.id } });
    expect(found?.name).toBe(name);

    await prisma.project.delete({ where: { id: created.id } });
    const afterDelete = await prisma.project.findUnique({ where: { id: created.id } });
    expect(afterDelete).toBeNull();
  });
});
