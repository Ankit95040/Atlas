import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (prisma === undefined) {
    prisma = new PrismaClient();
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
