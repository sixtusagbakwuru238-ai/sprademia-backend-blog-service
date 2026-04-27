// src/server.ts
// Application entry point.
// Wires together Fastify, plugins, routes, database, Redis,
// RabbitMQ event consumers, and background jobs.

import Fastify from "fastify";
import { config, isDev } from "./config";
import { connectPrisma, disconnectPrisma, prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { connectMessageBus, disconnectMessageBus } from "./lib/message-bus";
import { registerEventConsumers } from "./lib/event-consumers";
import { registerPlugins, registerErrorHandler, registerHooks } from "./plugins";
import { postsRoutes } from "./modules/posts";
import { categoriesRoutes } from "./modules/categories";
import { tagsRoutes } from "./modules/tags";
import { commentsRoutes } from "./modules/comments";
import { newsletterRoutes } from "./modules/newsletter";
import { searchRoutes } from "./modules/search";
import { authorsRoutes } from "./modules/authors";
import { startJobs, stopJobs } from "./jobs";

// ─────────────────────────────────────────────────────────────────────
// Build the Fastify application
// ─────────────────────────────────────────────────────────────────────

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(isDev && {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    trustProxy: true,  // Required when behind nginx / API gateway
    bodyLimit: config.MAX_CONTENT_LENGTH_MB * 1024 * 1024,
  });

  // Plugins (order matters — helmet/cors before routes)
  await registerPlugins(app);
  registerErrorHandler(app);
  registerHooks(app);

  // ── Health & readiness endpoints ───────────────────────────────────
  app.get("/health", async () => ({ status: "ok", service: config.SERVICE_NAME }));

  app.get("/ready", async (_req, reply) => {
    try {
      // Check database connectivity (avoid optional chain tag — esbuild limitation)
      await prisma.$queryRawUnsafe("SELECT 1");
      // Check Redis
      await redis.ping();
      return reply.send({ status: "ready" });
    } catch (err) {
      return reply.code(503).send({
        status: "not_ready",
        reason: (err as Error).message,
      });
    }
  });

  // ── API routes (all prefixed /api/v1) ────────────────────────────
  app.register(
    async (api) => {
      api.register(postsRoutes);
      api.register(categoriesRoutes);
      api.register(tagsRoutes);
      api.register(commentsRoutes);
      api.register(newsletterRoutes);
      api.register(searchRoutes);
      api.register(authorsRoutes);
    },
    { prefix: "/api/v1" }
  );

  return app;
}

// ─────────────────────────────────────────────────────────────────────
// Start the server
// ─────────────────────────────────────────────────────────────────────

async function start() {
  const app = await buildApp();

  try {
    // Connect to external services
    await connectPrisma();
    app.log.info("PostgreSQL connected");

    await redis.connect();
    app.log.info("Redis connected");

    await connectMessageBus();
    app.log.info("RabbitMQ connected");

    // Register event consumers after message bus is ready
    await registerEventConsumers();

    // Start background jobs
    startJobs();

    // Start HTTP server
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      `${config.SERVICE_NAME} running on ${config.HOST}:${config.PORT}`
    );

    if (isDev) {
      app.log.info(`Swagger docs: http://localhost:${config.PORT}/docs`);
    }
  } catch (err) {
    app.log.fatal(err, "Failed to start server");
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.info(`\n[server] ${signal} received — shutting down gracefully`);

  stopJobs();
  await disconnectMessageBus();
  await disconnectPrisma();
  await redis.quit();

  console.info("[server] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Crash safety — log unhandled rejections instead of silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
  process.exit(1);
});

start();


// // src/server.ts
// // Application entry point.
// // Wires together Fastify, plugins, routes, database, Redis,
// // RabbitMQ event consumers, and background jobs.

// import Fastify from "fastify";
// import { config, isDev } from "./config";
// import { connectPrisma, disconnectPrisma, prisma } from "./lib/prisma";
// import { redis } from "./lib/redis";
// import { connectMessageBus, disconnectMessageBus } from "./lib/message-bus";
// import { registerEventConsumers } from "./lib/event-consumers";
// import { registerPlugins, registerErrorHandler, registerHooks } from "./plugins";
// import { postsRoutes } from "./modules/posts";
// import { categoriesRoutes } from "./modules/categories";
// import { tagsRoutes } from "./modules/tags";
// import { registerCommentsRoutes } from "./modules/comments";
// import { newsletterRoutes } from "./modules/newsletter";
// import { searchRoutes } from "./modules/search";
// import { authorsRoutes } from "./modules/authors";
// import { startJobs, stopJobs } from "./jobs";

// // ─────────────────────────────────────────────────────────────────────
// // Build the Fastify application
// // ─────────────────────────────────────────────────────────────────────

// export async function buildApp() {
//   const app = Fastify({
//     logger: {
//       level: config.LOG_LEVEL,
//       ...(isDev && {
//         transport: {
//           target: "pino-pretty",
//           options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
//         },
//       }),
//     },
//     requestIdHeader: "x-request-id",
//     requestIdLogLabel: "requestId",
//     trustProxy: true,  // Required when behind nginx / API gateway
//     bodyLimit: config.MAX_CONTENT_LENGTH_MB * 1024 * 1024,
//   });

//   // Plugins (order matters — helmet/cors before routes)
//   await registerPlugins(app);
//   registerErrorHandler(app);
//   registerHooks(app);

//   // ── Health & readiness endpoints ───────────────────────────────────
//   app.get("/health", async () => ({ status: "ok", service: config.SERVICE_NAME }));

//   app.get("/ready", async (_req, reply) => {
//     try {
//       // Check database connectivity (avoid optional chain tag — esbuild limitation)
//       await prisma.$queryRawUnsafe("SELECT 1");
//       // Check Redis
//       await redis.ping();
//       return reply.send({ status: "ready" });
//     } catch (err) {
//       return reply.code(503).send({
//         status: "not_ready",
//         reason: (err as Error).message,
//       });
//     }
//   });

//   // ── API routes (all prefixed /api/v1) ────────────────────────────
//   app.register(
//     async (api) => {
//       api.register(postsRoutes);
//       api.register(categoriesRoutes);
//       api.register(tagsRoutes);
//       api.register(registerCommentsRoutes);
//       api.register(newsletterRoutes);
//       api.register(searchRoutes);
//       api.register(authorsRoutes);
//     },
//     { prefix: "/api/v1" }
//   );

//   return app;
// }

// // ─────────────────────────────────────────────────────────────────────
// // Start the server
// // ─────────────────────────────────────────────────────────────────────

// async function start() {
//   const app = await buildApp();

//   try {
//     // Connect to external services
//     await connectPrisma();
//     app.log.info("PostgreSQL connected");

//     await redis.connect();
//     app.log.info("Redis connected");

//     await connectMessageBus();
//     app.log.info("RabbitMQ connected");

//     // Register event consumers after message bus is ready
//     await registerEventConsumers();

//     // Start background jobs
//     startJobs();

//     // Start HTTP server
//     await app.listen({ port: config.PORT, host: config.HOST });
//     app.log.info(
//       `${config.SERVICE_NAME} running on ${config.HOST}:${config.PORT}`
//     );

//     if (isDev) {
//       app.log.info(`Swagger docs: http://localhost:${config.PORT}/docs`);
//     }
//   } catch (err) {
//     app.log.fatal(err, "Failed to start server");
//     process.exit(1);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Graceful shutdown
// // ─────────────────────────────────────────────────────────────────────

// async function shutdown(signal: string) {
//   console.info(`\n[server] ${signal} received — shutting down gracefully`);

//   stopJobs();
//   await disconnectMessageBus();
//   await disconnectPrisma();
//   await redis.quit();

//   console.info("[server] Shutdown complete");
//   process.exit(0);
// }

// process.on("SIGTERM", () => shutdown("SIGTERM"));
// process.on("SIGINT",  () => shutdown("SIGINT"));

// // Crash safety — log unhandled rejections instead of silent crashes
// process.on("unhandledRejection", (reason) => {
//   console.error("[server] Unhandled rejection:", reason);
//   process.exit(1);
// });

// start();



// // src/server.ts
// // Application entry point.
// // Wires together Fastify, plugins, routes, database, Redis,
// // RabbitMQ event consumers, and background jobs.

// import Fastify from "fastify";
// import { config, isDev } from "./config";
// import { connectPrisma, disconnectPrisma, prisma } from "./lib/prisma";
// import { redis } from "./lib/redis";
// import { connectMessageBus, disconnectMessageBus } from "./lib/message-bus";
// import { registerEventConsumers } from "./lib/event-consumers";
// import { registerPlugins, registerErrorHandler, registerHooks } from "./plugins";
// import { postsRoutes } from "./modules/posts";
// import { categoriesRoutes } from "./modules/categories";
// import { tagsRoutes } from "./modules/tags";
// import { registerCommentsRoutes } from "./modules/comments";
// import { newsletterRoutes } from "./modules/newsletter";
// import { searchRoutes } from "./modules/search";
// import { authorsRoutes } from "./modules/authors";
// import { startJobs, stopJobs } from "./jobs";

// // ─────────────────────────────────────────────────────────────────────
// // Build the Fastify application
// // ─────────────────────────────────────────────────────────────────────

// export async function buildApp() {
//   const app = Fastify({
//     logger: {
//       level: config.LOG_LEVEL,
//       ...(isDev && {
//         transport: {
//           target: "pino-pretty",
//           options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
//         },
//       }),
//     },
//     requestIdHeader: "x-request-id",
//     requestIdLogLabel: "requestId",
//     trustProxy: true,  // Required when behind nginx / API gateway
//     bodyLimit: config.MAX_CONTENT_LENGTH_MB * 1024 * 1024,
//   });

//   // Plugins (order matters — helmet/cors before routes)
//   await registerPlugins(app);
//   registerErrorHandler(app);
//   registerHooks(app);

//   // ── Health & readiness endpoints ───────────────────────────────────
//   app.get("/health", async () => ({ status: "ok", service: config.SERVICE_NAME }));

//   app.get("/ready", async (_req, reply) => {
//     try {
//       // Check database connectivity (avoid optional chain tag — esbuild limitation)
//       await prisma.$queryRawUnsafe("SELECT 1");
//       // Check Redis
//       await redis.ping();
//       return reply.send({ status: "ready" });
//     } catch (err) {
//       return reply.code(503).send({
//         status: "not_ready",
//         reason: (err as Error).message,
//       });
//     }
//   });

//   // ── API routes (all prefixed /api/v1) ────────────────────────────
//   app.register(
//     async (api) => {
//       api.register(postsRoutes);
//       api.register(categoriesRoutes);
//       api.register(tagsRoutes);
//       api.register(registerCommentsRoutes);
//       api.register(newsletterRoutes);
//       api.register(searchRoutes);
//       api.register(authorsRoutes);
//     },
//     { prefix: "/api/v1" }
//   );

//   return app;
// }

// // ─────────────────────────────────────────────────────────────────────
// // Start the server
// // ─────────────────────────────────────────────────────────────────────

// async function start() {
//   const app = await buildApp();

//   try {
//     // Connect to external services
//     await connectPrisma();
//     app.log.info("PostgreSQL connected");

//     await redis.connect();
//     app.log.info("Redis connected");

//     await connectMessageBus();
//     app.log.info("RabbitMQ connected");

//     // Register event consumers after message bus is ready
//     await registerEventConsumers();

//     // Start background jobs
//     startJobs();

//     // Start HTTP server
//     await app.listen({ port: config.PORT, host: config.HOST });
//     app.log.info(
//       `${config.SERVICE_NAME} running on ${config.HOST}:${config.PORT}`
//     );

//     if (isDev) {
//       app.log.info(`Swagger docs: http://localhost:${config.PORT}/docs`);
//     }
//   } catch (err) {
//     app.log.fatal(err, "Failed to start server");
//     process.exit(1);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Graceful shutdown
// // ─────────────────────────────────────────────────────────────────────

// async function shutdown(signal: string) {
//   console.info(`\n[server] ${signal} received — shutting down gracefully`);

//   stopJobs();
//   await disconnectMessageBus();
//   await disconnectPrisma();
//   await redis.quit();

//   console.info("[server] Shutdown complete");
//   process.exit(0);
// }

// process.on("SIGTERM", () => shutdown("SIGTERM"));
// process.on("SIGINT",  () => shutdown("SIGINT"));

// // Crash safety — log unhandled rejections instead of silent crashes
// process.on("unhandledRejection", (reason) => {
//   console.error("[server] Unhandled rejection:", reason);
//   process.exit(1);
// });

// start();





// // src/server.ts
// // Application entry point.
// // Wires together Fastify, plugins, routes, database, Redis,
// // RabbitMQ event consumers, and background jobs.

// import Fastify from "fastify";
// import { config, isDev } from "./config";
// import { connectPrisma, disconnectPrisma } from "./lib/prisma";
// import { redis } from "./lib/redis";
// import { connectMessageBus, disconnectMessageBus } from "./lib/message-bus";
// import { registerEventConsumers } from "./lib/event-consumers";
// import { registerPlugins, registerErrorHandler, registerHooks } from "./plugins";
// import { postsRoutes } from "./modules/posts";
// import { categoriesRoutes } from "./modules/categories";
// import { tagsRoutes } from "./modules/tags";
// import { registerCommentsRoutes } from "./modules/comments";
// import { newsletterRoutes } from "./modules/newsletter";
// import { searchRoutes } from "./modules/search";
// import { authorsRoutes } from "./modules/authors";
// import { startJobs, stopJobs } from "./jobs";

// // ─────────────────────────────────────────────────────────────────────
// // Build the Fastify application
// // ─────────────────────────────────────────────────────────────────────

// export async function buildApp() {
//   const app = Fastify({
//     logger: {
//       level: config.LOG_LEVEL,
//       ...(isDev && {
//         transport: {
//           target: "pino-pretty",
//           options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
//         },
//       }),
//     },
//     requestIdHeader: "x-request-id",
//     requestIdLogLabel: "requestId",
//     trustProxy: true,  // Required when behind nginx / API gateway
//     bodyLimit: config.MAX_CONTENT_LENGTH_MB * 1024 * 1024,
//   });

//   // Plugins (order matters — helmet/cors before routes)
//   await registerPlugins(app);
//   registerErrorHandler(app);
//   registerHooks(app);

//   // ── Health & readiness endpoints ───────────────────────────────────
//   app.get("/health", async () => ({ status: "ok", service: config.SERVICE_NAME }));

//   app.get("/ready", async (_req, reply) => {
//     try {
//       // Check database connectivity
//       if (!app.prisma) throw new Error("Prisma not initialized");
// await app.prisma.$queryRaw`SELECT 1`;
//       // Check Redis
//       await redis.ping();
//       return reply.send({ status: "ready" });
//     } catch (err) {
//       return reply.code(503).send({
//         status: "not_ready",
//         reason: (err as Error).message,
//       });
//     }
//   });

//   // ── API routes (all prefixed /api/v1) ────────────────────────────
//   app.register(
//     async (api) => {
//       api.register(postsRoutes);
//       api.register(categoriesRoutes);
//       api.register(tagsRoutes);
//       api.register(registerCommentsRoutes);
//       api.register(newsletterRoutes);
//       api.register(searchRoutes);
//       api.register(authorsRoutes);
//     },
//     { prefix: "/api/v1" }
//   );

//   return app;
// }

// // ─────────────────────────────────────────────────────────────────────
// // Start the server
// // ─────────────────────────────────────────────────────────────────────

// async function start() {
//   const app = await buildApp();

//   try {
//     // Connect to external services
//     await connectPrisma();
//     app.log.info("PostgreSQL connected");

//     await redis.connect();
//     app.log.info("Redis connected");

//     await connectMessageBus();
//     app.log.info("RabbitMQ connected");

//     // Register event consumers after message bus is ready
//     await registerEventConsumers();

//     // Start background jobs
//     startJobs();

//     // Start HTTP server
//     await app.listen({ port: config.PORT, host: config.HOST });
//     app.log.info(
//       `${config.SERVICE_NAME} running on ${config.HOST}:${config.PORT}`
//     );

//     if (isDev) {
//       app.log.info(`Swagger docs: http://localhost:${config.PORT}/docs`);
//     }
//   } catch (err) {
//     app.log.fatal(err, "Failed to start server");
//     process.exit(1);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Graceful shutdown
// // ─────────────────────────────────────────────────────────────────────

// async function shutdown(signal: string) {
//   console.info(`\n[server] ${signal} received — shutting down gracefully`);

//   stopJobs();
//   await disconnectMessageBus();
//   await disconnectPrisma();
//   await redis.quit();

//   console.info("[server] Shutdown complete");
//   process.exit(0);
// }

// process.on("SIGTERM", () => shutdown("SIGTERM"));
// process.on("SIGINT",  () => shutdown("SIGINT"));

// // Crash safety — log unhandled rejections instead of silent crashes
// process.on("unhandledRejection", (reason) => {
//   console.error("[server] Unhandled rejection:", reason);
//   process.exit(1);
// });

// start();