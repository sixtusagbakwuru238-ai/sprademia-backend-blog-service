// src/middleware/auth.ts
// JWT authentication middleware and role-based access control.
// We do NOT augment FastifyRequest.user — @fastify/jwt already owns that
// property. Instead we store the decoded user on request.authenticatedUser
// via a Fastify decorator, avoiding the TS2687 modifier conflict entirely.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRole, AuthenticatedUser, JWTPayload } from "../types";

// ─────────────────────────────────────────────────────────────────────
// Extend FastifyRequest with our own property (not 'user')
// ─────────────────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    authenticatedUser?: AuthenticatedUser;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Authenticate — require valid JWT
// ─────────────────────────────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const payload = await request.jwtVerify<JWTPayload>();
    request.authenticatedUser = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      schoolId: payload.schoolId,
    };
  } catch {
    reply.code(401).send({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Valid authentication token required" },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Optional auth — sets authenticatedUser if token present, silent if not
// ─────────────────────────────────────────────────────────────────────

export async function optionalAuthenticate(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return;
  try {
    const payload = await request.jwtVerify<JWTPayload>();
    request.authenticatedUser = {
      id:       payload.sub,
      email:    payload.email,
      role:     payload.role,
      schoolId: payload.schoolId,
    };
  } catch {
    // Silently ignore invalid/expired tokens
  }
}

// ─────────────────────────────────────────────────────────────────────
// Role guards
// ─────────────────────────────────────────────────────────────────────

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authenticatedUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
    }
    if (!roles.includes(user.role)) {
      return reply.code(403).send({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `This action requires one of the following roles: ${roles.join(", ")}`,
        },
      });
    }
  };
}

export const requireEditor  = requireRole("editor", "admin");
export const requireAdmin   = requireRole("admin");
export const requireCreator = requireRole("creator", "editor", "admin");

// ─────────────────────────────────────────────────────────────────────
// Internal service-to-service key auth
// ─────────────────────────────────────────────────────────────────────

export async function requireInternalKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { config } = await import("../config");
  const key = request.headers["x-internal-api-key"];
  if (key !== config.INTERNAL_API_KEY) {
    reply.code(401).send({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Invalid internal API key" },
    });
  }
}

// // src/middleware/auth.ts
// // JWT authentication middleware and role-based access control decorators.
// // JWT is issued by the Auth service — this service only validates it.

// import type { FastifyRequest, FastifyReply } from "fastify";
// import type { UserRole, AuthenticatedUser, JWTPayload } from "../types";

// // ─────────────────────────────────────────────────────────────────────
// // Extract and verify JWT from Authorization header
// // ─────────────────────────────────────────────────────────────────────

// export async function authenticate(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   try {
//     // @fastify/jwt adds verify() to request
//     const payload = await request.jwtVerify<JWTPayload>();

//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     reply.code(401).send({
//       success: false,
//       error: {
//         code: "UNAUTHORIZED",
//         message: "Valid authentication token required",
//       },
//     });
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Optional auth — sets request.user if token present, doesn't fail if not
// // ─────────────────────────────────────────────────────────────────────

// export async function optionalAuthenticate(
//   request: FastifyRequest,
//   _reply: FastifyReply
// ): Promise<void> {
//   const authHeader = request.headers.authorization;
//   if (!authHeader?.startsWith("Bearer ")) return;

//   try {
//     const payload = await request.jwtVerify<JWTPayload>();
//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     // Silently ignore invalid/expired tokens in optional mode
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Role guards — compose after authenticate
// // ─────────────────────────────────────────────────────────────────────

// export function requireRole(...roles: UserRole[]) {
//   return async (request: FastifyRequest, reply: FastifyReply) => {
//     const user = request.user as AuthenticatedUser | undefined;

//     if (!user) {
//       reply.code(401).send({
//         success: false,
//         error: { code: "UNAUTHORIZED", message: "Authentication required" },
//       });
//       return;
//     }

//     if (!roles.includes(user.role)) {
//       reply.code(403).send({
//         success: false,
//         error: {
//           code: "FORBIDDEN",
//           message: `This action requires one of the following roles: ${roles.join(", ")}`,
//         },
//       });
//     }
//   };
// }

// // Convenience shortcuts
// export const requireEditor = requireRole("editor", "admin");
// export const requireAdmin = requireRole("admin");
// export const requireCreator = requireRole("creator", "editor", "admin");

// // ─────────────────────────────────────────────────────────────────────
// // Internal service-to-service auth
// // ─────────────────────────────────────────────────────────────────────

// export async function requireInternalKey(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   const { config } = await import("../config");
//   const key = request.headers["x-internal-api-key"];

//   if (key !== config.INTERNAL_API_KEY) {
//     reply.code(401).send({
//       success: false,
//       error: { code: "UNAUTHORIZED", message: "Invalid internal API key" },
//     });
//   }
// }



// // src/middleware/auth.ts
// // JWT authentication middleware and role-based access control decorators.
// // JWT is issued by the Auth service — this service only validates it.

// import type { FastifyRequest, FastifyReply } from "fastify";
// import type { UserRole, AuthenticatedUser, JWTPayload } from "../types";

// // ─────────────────────────────────────────────────────────────────────
// // Extract and verify JWT from Authorization header
// // ─────────────────────────────────────────────────────────────────────

// export async function authenticate(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   try {
//     // @fastify/jwt adds verify() to request
//     const payload = await request.jwtVerify<JWTPayload>();

//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     reply.code(401).send({
//       success: false,
//       error: {
//         code: "UNAUTHORIZED",
//         message: "Valid authentication token required",
//       },
//     });
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Optional auth — sets request.user if token present, doesn't fail if not
// // ─────────────────────────────────────────────────────────────────────

// export async function optionalAuthenticate(
//   request: FastifyRequest,
//   _reply: FastifyReply
// ): Promise<void> {
//   const authHeader = request.headers.authorization;
//   if (!authHeader?.startsWith("Bearer ")) return;

//   try {
//     const payload = await request.jwtVerify<JWTPayload>();
//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     // Silently ignore invalid/expired tokens in optional mode
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Role guards — compose after authenticate
// // ─────────────────────────────────────────────────────────────────────

// export function requireRole(...roles: UserRole[]) {
//   return async (request: FastifyRequest, reply: FastifyReply) => {
//     const user = request.user as AuthenticatedUser | undefined;

//     if (!user) {
//       reply.code(401).send({
//         success: false,
//         error: { code: "UNAUTHORIZED", message: "Authentication required" },
//       });
//       return;
//     }

//     if (!roles.includes(user.role)) {
//       reply.code(403).send({
//         success: false,
//         error: {
//           code: "FORBIDDEN",
//           message: `This action requires one of the following roles: ${roles.join(", ")}`,
//         },
//       });
//     }
//   };
// }

// // Convenience shortcuts
// export const requireEditor = requireRole("editor", "admin");
// export const requireAdmin = requireRole("admin");
// export const requireCreator = requireRole("creator", "editor", "admin");

// // ─────────────────────────────────────────────────────────────────────
// // Internal service-to-service auth
// // ─────────────────────────────────────────────────────────────────────

// export async function requireInternalKey(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   const { config } = await import("../config");
//   const key = request.headers["x-internal-api-key"];

//   if (key !== config.INTERNAL_API_KEY) {
//     reply.code(401).send({
//       success: false,
//       error: { code: "UNAUTHORIZED", message: "Invalid internal API key" },
//     });
//   }
// }


// // src/middleware/auth.ts
// // JWT authentication middleware and role-based access control decorators.
// // JWT is issued by the Auth service — this service only validates it.

// import type { FastifyRequest, FastifyReply } from "fastify";
// import type { UserRole, AuthenticatedUser, JWTPayload } from "../types";

// // ─────────────────────────────────────────────────────────────────────
// // Extract and verify JWT from Authorization header
// // ─────────────────────────────────────────────────────────────────────

// export async function authenticate(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   try {
//     // @fastify/jwt adds verify() to request
//     const payload = await request.jwtVerify<JWTPayload>();

//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     reply.code(401).send({
//       success: false,
//       error: {
//         code: "UNAUTHORIZED",
//         message: "Valid authentication token required",
//       },
//     });
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Optional auth — sets request.user if token present, doesn't fail if not
// // ─────────────────────────────────────────────────────────────────────

// export async function optionalAuthenticate(
//   request: FastifyRequest,
//   _reply: FastifyReply
// ): Promise<void> {
//   const authHeader = request.headers.authorization;
//   if (!authHeader?.startsWith("Bearer ")) return;

//   try {
//     const payload = await request.jwtVerify<JWTPayload>();
//     request.user = {
//       id: payload.sub,
//       email: payload.email,
//       role: payload.role,
//       schoolId: payload.schoolId,
//     };
//   } catch {
//     // Silently ignore invalid/expired tokens in optional mode
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Role guards — compose after authenticate
// // ─────────────────────────────────────────────────────────────────────

// export function requireRole(...roles: UserRole[]) {
//   return async (request: FastifyRequest, reply: FastifyReply) => {
//     const user = request.user as AuthenticatedUser | undefined;

//     if (!user) {
//       reply.code(401).send({
//         success: false,
//         error: { code: "UNAUTHORIZED", message: "Authentication required" },
//       });
//       return;
//     }

//     if (!roles.includes(user.role)) {
//       reply.code(403).send({
//         success: false,
//         error: {
//           code: "FORBIDDEN",
//           message: `This action requires one of the following roles: ${roles.join(", ")}`,
//         },
//       });
//     }
//   };
// }

// // Convenience shortcuts
// export const requireEditor = requireRole("editor", "admin");
// export const requireAdmin = requireRole("admin");
// export const requireCreator = requireRole("creator", "editor", "admin");

// // ─────────────────────────────────────────────────────────────────────
// // Internal service-to-service auth
// // ─────────────────────────────────────────────────────────────────────

// export async function requireInternalKey(
//   request: FastifyRequest,
//   reply: FastifyReply
// ): Promise<void> {
//   const { config } = await import("../config");
//   const key = request.headers["x-internal-api-key"];

//   if (key !== config.INTERNAL_API_KEY) {
//     reply.code(401).send({
//       success: false,
//       error: { code: "UNAUTHORIZED", message: "Invalid internal API key" },
//     });
//   }
// }