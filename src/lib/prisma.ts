// src/lib/prisma.ts
// Singleton Prisma client.
// In development, cached on global to survive hot-reloads.

import { PrismaClient } from "@prisma/client";
import { config } from "../config";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient() {
  return new PrismaClient({
    log:
      config.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
    datasources: {
      db: { url: config.DATABASE_URL },
    },
  });
}

export const prisma: PrismaClient =
  global.__prisma ?? createPrismaClient();

if (config.NODE_ENV !== "production") {
  global.__prisma = prisma;
}

export async function connectPrisma() {
  await prisma.$connect();
}

export async function disconnectPrisma() {
  await prisma.$disconnect();
}



// // src/lib/prisma.ts
// // Singleton Prisma client.
// // In development, cached on global to survive hot-reloads.

// import { PrismaClient } from "@prisma/client";
// import { config } from "../config";

// declare global {
//   // eslint-disable-next-line no-var
//   var __prisma: PrismaClient | undefined;
// }

// function createPrismaClient() {
//   return new PrismaClient({
//     log:
//       config.NODE_ENV === "development"
//         ? ["query", "warn", "error"]
//         : ["warn", "error"],
//     datasources: {
//       db: { url: config.DATABASE_URL },
//     },
//   });
// }

// export const prisma: PrismaClient =
//   global.__prisma ?? createPrismaClient();

// if (config.NODE_ENV !== "production") {
//   global.__prisma = prisma;
// }

// export async function connectPrisma() {
//   await prisma.$connect();
// }

// export async function disconnectPrisma() {
//   await prisma.$disconnect();
// }



// // src/lib/prisma.ts
// // Singleton Prisma client.
// // In development, cached on global to survive hot-reloads.

// import { PrismaClient } from "@prisma/client";
// import { config } from "../config";

// declare global {
//   // eslint-disable-next-line no-var
//   var __prisma: PrismaClient | undefined;
// }

// function createPrismaClient() {
//   return new PrismaClient({
//     log:
//       config.NODE_ENV === "development"
//         ? ["query", "warn", "error"]
//         : ["warn", "error"],
//     datasources: {
//       db: { url: config.DATABASE_URL },
//     },
//   });
// }

// export const prisma: PrismaClient =
//   global.__prisma ?? createPrismaClient();

// if (config.NODE_ENV !== "production") {
//   global.__prisma = prisma;
// }

// export async function connectPrisma() {
//   await prisma.$connect();
// }

// export async function disconnectPrisma() {
//   await prisma.$disconnect();
// }