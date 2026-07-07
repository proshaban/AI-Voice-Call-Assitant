import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 moved the CLI's datasource URL (used by `migrate`, `studio`, etc.)
// out of schema.prisma and into this file. The running app's PrismaClient
// still gets its connection separately, via the pg adapter in
// src/lib/prisma.ts — this file is CLI-only.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});