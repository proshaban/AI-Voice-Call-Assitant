import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7's default "client" query engine has no bundled binary — it needs
// a driver adapter to actually talk to the database. For Postgres, that's
// @prisma/adapter-pg wrapping a `pg` Pool/connection string.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});