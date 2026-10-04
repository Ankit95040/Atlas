import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "../config/state.js";

let prisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (prisma === undefined) {
    // M28.1: honor per-project state resolution without env mutation.
    // With no DATABASE_URL and no .atlas/atlas.db above cwd this resolves
    // to the legacy file:./dev.db — byte-identical behavior to before.
    prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl().databaseUrl });
  }
  return prisma;
}

export async function checkDatabaseConnection(client: PrismaClient = getPrismaClient()): Promise<boolean> {
  await client.$queryRaw`SELECT 1`;
  return true;
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma !== undefined) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}
