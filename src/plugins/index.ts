// src/plugins/index.ts
// Fastify plugin registrations:
//   - CORS
//   - Helmet (security headers)
//   - Rate limiting
//   - JWT
//   - Swagger / OpenAPI docs
//   - Global error handler
//   - Request logging

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyJwt from "@fastify/jwt";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { ZodError } from "zod";
import { config, corsOrigins, isDev } from "../config";
import { redis } from "../lib/redis";

export async function registerPlugins(fastify: FastifyInstance) {

  // ── Security headers ──────────────────────────────────────────────
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  });

  // ── CORS ──────────────────────────────────────────────────────────
  await fastify.register(fastifyCors, {
    origin: (origin, callback) => {
      // Allow no-origin requests (server-to-server, Postman, curl)
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`), false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Internal-Api-Key",
      "X-Request-Id",
    ],
    credentials: true,
    maxAge: 86_400,
  });

  // ── Rate limiting (backed by Redis) ───────────────────────────────
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    redis,
    keyGenerator: (request: FastifyRequest) =>
      // Authenticated users get their own bucket; anonymous share by IP
      request.headers.authorization
        ? `user:${request.headers.authorization.slice(-20)}`
        : `ip:${request.ip}`,
    errorResponseBuilder: () => ({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please slow down.",
      },
    }),
  });

  // ── JWT ───────────────────────────────────────────────────────────
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    decode: { complete: true },
    sign: { expiresIn: "7d" },
  });

  // ── OpenAPI / Swagger ─────────────────────────────────────────────
  if (isDev) {
    await fastify.register(fastifySwagger, {
      openapi: {
        openapi: "3.0.3",
        info: {
          title: "StudyNation Blog Service API",
          description:
            "REST API for the StudyNation Blog microservice. Handles posts, categories, tags, comments, newsletter subscriptions and full-text search.",
          version: "1.0.0",
          contact: {
            name: "StudyNation Engineering",
            email: "engineering@studynation.ng",
          },
        },
        servers: [
          { url: `http://localhost:${config.PORT}`, description: "Local development" },
          { url: "https://api.studynation.ng/blog", description: "Production" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: "Posts",        description: "Blog post CRUD and reactions" },
          { name: "Categories",   description: "Post categories" },
          { name: "Tags",         description: "Post tags" },
          { name: "Comments",     description: "Threaded comments with moderation" },
          { name: "Newsletter",   description: "Email subscription management" },
          { name: "Search",       description: "Full-text search and suggestions" },
          { name: "Authors",      description: "Author profiles (read-only)" },
        ],
      },
    });

    await fastify.register(fastifySwaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
        persistAuthorization: true,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────────────

export function registerErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((error, request, reply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
      });
    }

    // Business logic errors with codes
    const errCode = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (errCode === "CONFLICT") {
      return reply.code(409).send({
        success: false,
        error: { code: "CONFLICT", message: error.message },
      });
    }
    if (errCode === "BAD_REQUEST") {
      return reply.code(400).send({
        success: false,
        error: { code: "BAD_REQUEST", message: error.message },
      });
    }
    if (errCode === "FORBIDDEN") {
      return reply.code(403).send({
        success: false,
        error: { code: "FORBIDDEN", message: error.message },
      });
    }

    // Rate limit (already formatted by plugin)
    if (error.statusCode === 429) {
      return reply.code(429).send(error);
    }

    // Log unexpected server errors
    request.log.error({ err: error }, "Unhandled error");

    // In production, hide internal error details
    const message = isDev ? error.message : "An unexpected error occurred";

    return reply.code(error.statusCode ?? 500).send({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message,
        ...(isDev && { stack: error.stack }),
      },
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Request ID hook (for distributed tracing)
// ─────────────────────────────────────────────────────────────────────

export function registerHooks(fastify: FastifyInstance) {
  fastify.addHook("onRequest", async (request) => {
    // Propagate X-Request-Id from the API gateway for tracing
    if (!request.headers["x-request-id"]) {
      request.headers["x-request-id"] = `blog-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
    }
  });
}




// // src/plugins/index.ts
// // Fastify plugin registrations:
// //   - CORS
// //   - Helmet (security headers)
// //   - Rate limiting
// //   - JWT
// //   - Swagger / OpenAPI docs
// //   - Global error handler
// //   - Request logging

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import fastifyCors from "@fastify/cors";
// import fastifyHelmet from "@fastify/helmet";
// import fastifyRateLimit from "@fastify/rate-limit";
// import fastifyJwt from "@fastify/jwt";
// import fastifySwagger from "@fastify/swagger";
// import fastifySwaggerUi from "@fastify/swagger-ui";
// import { ZodError } from "zod";
// import { config, corsOrigins, isDev } from "../config";
// import { redis } from "../lib/redis";

// export async function registerPlugins(fastify: FastifyInstance) {

//   // ── Security headers ──────────────────────────────────────────────
//   await fastify.register(fastifyHelmet, {
//     contentSecurityPolicy: {
//       directives: {
//         defaultSrc: ["'self'"],
//         scriptSrc: ["'self'"],
//         styleSrc: ["'self'", "'unsafe-inline'"],
//         imgSrc: ["'self'", "data:", "https:"],
//       },
//     },
//   });

//   // ── CORS ──────────────────────────────────────────────────────────
//   await fastify.register(fastifyCors, {
//     origin: (origin, callback) => {
//       // Allow no-origin requests (server-to-server, Postman, curl)
//       if (!origin) return callback(null, true);
//       if (corsOrigins.includes(origin)) return callback(null, true);
//       callback(new Error(`CORS: origin ${origin} not allowed`), false);
//     },
//     methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
//     allowedHeaders: [
//       "Content-Type",
//       "Authorization",
//       "X-Internal-Api-Key",
//       "X-Request-Id",
//     ],
//     credentials: true,
//     maxAge: 86_400,
//   });

//   // ── Rate limiting (backed by Redis) ───────────────────────────────
//   await fastify.register(fastifyRateLimit, {
//     global: true,
//     max: config.RATE_LIMIT_MAX,
//     timeWindow: config.RATE_LIMIT_WINDOW,
//     redis,
//     keyGenerator: (request: FastifyRequest) =>
//       // Authenticated users get their own bucket; anonymous share by IP
//       request.headers.authorization
//         ? `user:${request.headers.authorization.slice(-20)}`
//         : `ip:${request.ip}`,
//     errorResponseBuilder: () => ({
//       success: false,
//       error: {
//         code: "RATE_LIMITED",
//         message: "Too many requests. Please slow down.",
//       },
//     }),
//   });

//   // ── JWT ───────────────────────────────────────────────────────────
//   await fastify.register(fastifyJwt, {
//     secret: config.JWT_SECRET,
//     decode: { complete: true },
//     sign: { expiresIn: "7d" },
//   });

//   // ── OpenAPI / Swagger ─────────────────────────────────────────────
//   if (isDev) {
//     await fastify.register(fastifySwagger, {
//       openapi: {
//         openapi: "3.0.3",
//         info: {
//           title: "StudyNation Blog Service API",
//           description:
//             "REST API for the StudyNation Blog microservice. Handles posts, categories, tags, comments, newsletter subscriptions and full-text search.",
//           version: "1.0.0",
//           contact: {
//             name: "StudyNation Engineering",
//             email: "engineering@studynation.ng",
//           },
//         },
//         servers: [
//           { url: `http://localhost:${config.PORT}`, description: "Local development" },
//           { url: "https://api.studynation.ng/blog", description: "Production" },
//         ],
//         components: {
//           securitySchemes: {
//             bearerAuth: {
//               type: "http",
//               scheme: "bearer",
//               bearerFormat: "JWT",
//             },
//           },
//         },
//         security: [{ bearerAuth: [] }],
//         tags: [
//           { name: "Posts",        description: "Blog post CRUD and reactions" },
//           { name: "Categories",   description: "Post categories" },
//           { name: "Tags",         description: "Post tags" },
//           { name: "Comments",     description: "Threaded comments with moderation" },
//           { name: "Newsletter",   description: "Email subscription management" },
//           { name: "Search",       description: "Full-text search and suggestions" },
//           { name: "Authors",      description: "Author profiles (read-only)" },
//         ],
//       },
//     });

//     await fastify.register(fastifySwaggerUi, {
//       routePrefix: "/docs",
//       uiConfig: {
//         docExpansion: "list",
//         deepLinking: true,
//         persistAuthorization: true,
//       },
//     });
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Global error handler
// // ─────────────────────────────────────────────────────────────────────

// export function registerErrorHandler(fastify: FastifyInstance) {
//   fastify.setErrorHandler((error, request, reply) => {
//     // Zod validation errors
//     if (error instanceof ZodError) {
//       return reply.code(422).send({
//         success: false,
//         error: {
//           code: "VALIDATION_ERROR",
//           message: "Request validation failed",
//           details: error.issues.map((i) => ({
//             field: i.path.join("."),
//             message: i.message,
//           })),
//         },
//       });
//     }

//     // Business logic errors with codes
//     const errCode = (error as NodeJS.ErrnoException & { code?: string }).code;
//     if (errCode === "CONFLICT") {
//       return reply.code(409).send({
//         success: false,
//         error: { code: "CONFLICT", message: error.message },
//       });
//     }
//     if (errCode === "BAD_REQUEST") {
//       return reply.code(400).send({
//         success: false,
//         error: { code: "BAD_REQUEST", message: error.message },
//       });
//     }
//     if (errCode === "FORBIDDEN") {
//       return reply.code(403).send({
//         success: false,
//         error: { code: "FORBIDDEN", message: error.message },
//       });
//     }

//     // Rate limit (already formatted by plugin)
//     if (error.statusCode === 429) {
//       return reply.code(429).send(error);
//     }

//     // Log unexpected server errors
//     request.log.error({ err: error }, "Unhandled error");

//     // In production, hide internal error details
//     const message = isDev ? error.message : "An unexpected error occurred";

//     return reply.code(error.statusCode ?? 500).send({
//       success: false,
//       error: {
//         code: "INTERNAL_ERROR",
//         message,
//         ...(isDev && { stack: error.stack }),
//       },
//     });
//   });

//   // 404 handler
//   fastify.setNotFoundHandler((request, reply) => {
//     reply.code(404).send({
//       success: false,
//       error: {
//         code: "NOT_FOUND",
//         message: `Route ${request.method} ${request.url} not found`,
//       },
//     });
//   });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Request ID hook (for distributed tracing)
// // ─────────────────────────────────────────────────────────────────────

// export function registerHooks(fastify: FastifyInstance) {
//   fastify.addHook("onRequest", async (request) => {
//     // Propagate X-Request-Id from the API gateway for tracing
//     if (!request.headers["x-request-id"]) {
//       request.headers["x-request-id"] = `blog-${Date.now()}-${Math.random()
//         .toString(36)
//         .slice(2, 9)}`;
//     }
//   });
// }



// // src/plugins/index.ts
// // Fastify plugin registrations:
// //   - CORS
// //   - Helmet (security headers)
// //   - Rate limiting
// //   - JWT
// //   - Swagger / OpenAPI docs
// //   - Global error handler
// //   - Request logging

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import fastifyCors from "@fastify/cors";
// import fastifyHelmet from "@fastify/helmet";
// import fastifyRateLimit from "@fastify/rate-limit";
// import fastifyJwt from "@fastify/jwt";
// import fastifySwagger from "@fastify/swagger";
// import fastifySwaggerUi from "@fastify/swagger-ui";
// import { ZodError } from "zod";
// import { config, corsOrigins, isDev } from "../config";
// import { redis } from "../lib/redis";

// export async function registerPlugins(fastify: FastifyInstance) {

//   // ── Security headers ──────────────────────────────────────────────
//   await fastify.register(fastifyHelmet, {
//     contentSecurityPolicy: {
//       directives: {
//         defaultSrc: ["'self'"],
//         scriptSrc: ["'self'"],
//         styleSrc: ["'self'", "'unsafe-inline'"],
//         imgSrc: ["'self'", "data:", "https:"],
//       },
//     },
//   });

//   // ── CORS ──────────────────────────────────────────────────────────
//   await fastify.register(fastifyCors, {
//     origin: (origin, callback) => {
//       // Allow no-origin requests (server-to-server, Postman, curl)
//       if (!origin) return callback(null, true);
//       if (corsOrigins.includes(origin)) return callback(null, true);
//       callback(new Error(`CORS: origin ${origin} not allowed`), false);
//     },
//     methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
//     allowedHeaders: [
//       "Content-Type",
//       "Authorization",
//       "X-Internal-Api-Key",
//       "X-Request-Id",
//     ],
//     credentials: true,
//     maxAge: 86_400,
//   });

//   // ── Rate limiting (backed by Redis) ───────────────────────────────
//   await fastify.register(fastifyRateLimit, {
//     global: true,
//     max: config.RATE_LIMIT_MAX,
//     timeWindow: config.RATE_LIMIT_WINDOW,
//     redis,
//     keyGenerator: (request: FastifyRequest) =>
//       // Authenticated users get their own bucket; anonymous share by IP
//       request.headers.authorization
//         ? `user:${request.headers.authorization.slice(-20)}`
//         : `ip:${request.ip}`,
//     errorResponseBuilder: () => ({
//       success: false,
//       error: {
//         code: "RATE_LIMITED",
//         message: "Too many requests. Please slow down.",
//       },
//     }),
//   });

//   // ── JWT ───────────────────────────────────────────────────────────
//   await fastify.register(fastifyJwt, {
//     secret: config.JWT_SECRET,
//     decode: { complete: true },
//     sign: { expiresIn: "7d" },
//   });

//   // ── OpenAPI / Swagger ─────────────────────────────────────────────
//   if (isDev) {
//     await fastify.register(fastifySwagger, {
//       openapi: {
//         openapi: "3.0.3",
//         info: {
//           title: "Sprademia Blog Service API",
//           description:
//             "REST API for the Sprademia Blog microservice. Handles posts, categories, tags, comments, newsletter subscriptions and full-text search.",
//           version: "1.0.0",
//           contact: {
//             name: "Sprademia Engineering",
//             email: "engineering@sprademia.ng",
//           },
//         },
//         servers: [
//           { url: `http://localhost:${config.PORT}`, description: "Local development" },
//           { url: "https://api.sprademia.ng/blog", description: "Production" },
//         ],
//         components: {
//           securitySchemes: {
//             bearerAuth: {
//               type: "http",
//               scheme: "bearer",
//               bearerFormat: "JWT",
//             },
//           },
//         },
//         security: [{ bearerAuth: [] }],
//         tags: [
//           { name: "Posts",        description: "Blog post CRUD and reactions" },
//           { name: "Categories",   description: "Post categories" },
//           { name: "Tags",         description: "Post tags" },
//           { name: "Comments",     description: "Threaded comments with moderation" },
//           { name: "Newsletter",   description: "Email subscription management" },
//           { name: "Search",       description: "Full-text search and suggestions" },
//           { name: "Authors",      description: "Author profiles (read-only)" },
//         ],
//       },
//     });

//     await fastify.register(fastifySwaggerUi, {
//       routePrefix: "/docs",
//       uiConfig: {
//         docExpansion: "list",
//         deepLinking: true,
//         persistAuthorization: true,
//       },
//     });
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Global error handler
// // ─────────────────────────────────────────────────────────────────────

// export function registerErrorHandler(fastify: FastifyInstance) {
//   fastify.setErrorHandler((error, request, reply) => {
//     // Zod validation errors
//     if (error instanceof ZodError) {
//       return reply.code(422).send({
//         success: false,
//         error: {
//           code: "VALIDATION_ERROR",
//           message: "Request validation failed",
//           details: error.issues.map((i) => ({
//             field: i.path.join("."),
//             message: i.message,
//           })),
//         },
//       });
//     }

//     // Business logic errors with codes
//     const errCode = (error as NodeJS.ErrnoException & { code?: string }).code;
//     if (errCode === "CONFLICT") {
//       return reply.code(409).send({
//         success: false,
//         error: { code: "CONFLICT", message: error.message },
//       });
//     }
//     if (errCode === "BAD_REQUEST") {
//       return reply.code(400).send({
//         success: false,
//         error: { code: "BAD_REQUEST", message: error.message },
//       });
//     }
//     if (errCode === "FORBIDDEN") {
//       return reply.code(403).send({
//         success: false,
//         error: { code: "FORBIDDEN", message: error.message },
//       });
//     }

//     // Rate limit (already formatted by plugin)
//     if (error.statusCode === 429) {
//       return reply.code(429).send(error);
//     }

//     // Log unexpected server errors
//     request.log.error({ err: error }, "Unhandled error");

//     // In production, hide internal error details
//     const message = isDev ? error.message : "An unexpected error occurred";

//     return reply.code(error.statusCode ?? 500).send({
//       success: false,
//       error: {
//         code: "INTERNAL_ERROR",
//         message,
//         ...(isDev && { stack: error.stack }),
//       },
//     });
//   });

//   // 404 handler
//   fastify.setNotFoundHandler((request, reply) => {
//     reply.code(404).send({
//       success: false,
//       error: {
//         code: "NOT_FOUND",
//         message: `Route ${request.method} ${request.url} not found`,
//       },
//     });
//   });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Request ID hook (for distributed tracing)
// // ─────────────────────────────────────────────────────────────────────

// export function registerHooks(fastify: FastifyInstance) {
//   fastify.addHook("onRequest", async (request) => {
//     // Propagate X-Request-Id from the API gateway for tracing
//     if (!request.headers["x-request-id"]) {
//       request.headers["x-request-id"] = `blog-${Date.now()}-${Math.random()
//         .toString(36)
//         .slice(2, 9)}`;
//     }
//   });
// }