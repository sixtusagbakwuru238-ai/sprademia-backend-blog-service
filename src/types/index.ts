// src/types/index.ts

import type { FastifyRequest } from "fastify";

// ─────────────────────────────────────────────────────────────────────
// JWT payload — issued by the Auth service
// ─────────────────────────────────────────────────────────────────────

export interface JWTPayload {
  sub: string;          // userId
  email: string;
  role: UserRole;
  schoolId?: string;
  iat: number;
  exp: number;
}

export type UserRole = "student" | "creator" | "editor" | "admin";

// ─────────────────────────────────────────────────────────────────────
// Augmented Fastify request with decoded user
// ─────────────────────────────────────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  schoolId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────

export interface PaginationQuery {
  page: number;
  limit: number;
  cursor?: string;  // cursor-based pagination for feeds
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    nextCursor?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Canonical API response shapes
// ─────────────────────────────────────────────────────────────────────

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ─────────────────────────────────────────────────────────────────────
// RabbitMQ event envelopes (emitted by this service)
// ─────────────────────────────────────────────────────────────────────

export type BlogEventType =
  | "blog.post.published"
  | "blog.post.updated"
  | "blog.post.deleted"
  | "blog.comment.created"
  | "blog.comment.approved"
  | "blog.newsletter.subscribed"
  | "blog.newsletter.unsubscribed"
  | "blog.post.viewed";

export interface BlogEvent<T = unknown> {
  eventType: BlogEventType;
  serviceSource: "blog-service";
  timestamp: string;       // ISO 8601
  payload: T;
}

// Specific event payloads
export interface PostPublishedPayload {
  postId: string;
  slug: string;
  title: string;
  authorId: string;
  categorySlug: string;
  tags: string[];
  publishedAt: string;
}

export interface PostViewedPayload {
  postId: string;
  userId?: string;
  ipHash: string;
}

export interface NewsletterSubscribedPayload {
  subscriberId: string;
  email: string;
  firstName?: string;    // for personalising the welcome email
  categories: string[];
  token: string;         // unsubscribe / verify token
}


// // src/types/index.ts

// import type { FastifyRequest } from "fastify";

// // ─────────────────────────────────────────────────────────────────────
// // JWT payload — issued by the Auth service
// // ─────────────────────────────────────────────────────────────────────

// export interface JWTPayload {
//   sub: string;          // userId
//   email: string;
//   role: UserRole;
//   schoolId?: string;
//   iat: number;
//   exp: number;
// }

// export type UserRole = "student" | "creator" | "editor" | "admin";

// // ─────────────────────────────────────────────────────────────────────
// // Augmented Fastify request with decoded user
// // ─────────────────────────────────────────────────────────────────────

// export interface AuthenticatedUser {
//   id: string;
//   email: string;
//   role: UserRole;
//   schoolId?: string;
// }

// declare module "fastify" {
//   interface FastifyRequest {
//     user?: AuthenticatedUser;
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Pagination
// // ─────────────────────────────────────────────────────────────────────

// export interface PaginationQuery {
//   page: number;
//   limit: number;
//   cursor?: string;  // cursor-based pagination for feeds
// }

// export interface PaginatedResponse<T> {
//   data: T[];
//   pagination: {
//     total: number;
//     page: number;
//     limit: number;
//     totalPages: number;
//     hasNext: boolean;
//     hasPrev: boolean;
//     nextCursor?: string;
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Canonical API response shapes
// // ─────────────────────────────────────────────────────────────────────

// export interface ApiSuccess<T = unknown> {
//   success: true;
//   data: T;
//   meta?: Record<string, unknown>;
// }

// export interface ApiError {
//   success: false;
//   error: {
//     code: string;
//     message: string;
//     details?: unknown;
//   };
// }

// export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// // ─────────────────────────────────────────────────────────────────────
// // RabbitMQ event envelopes (emitted by this service)
// // ─────────────────────────────────────────────────────────────────────

// export type BlogEventType =
//   | "blog.post.published"
//   | "blog.post.updated"
//   | "blog.post.deleted"
//   | "blog.comment.created"
//   | "blog.comment.approved"
//   | "blog.newsletter.subscribed"
//   | "blog.newsletter.unsubscribed"
//   | "blog.post.viewed";

// export interface BlogEvent<T = unknown> {
//   eventType: BlogEventType;
//   serviceSource: "blog-service";
//   timestamp: string;       // ISO 8601
//   payload: T;
// }

// // Specific event payloads
// export interface PostPublishedPayload {
//   postId: string;
//   slug: string;
//   title: string;
//   authorId: string;
//   categorySlug: string;
//   tags: string[];
//   publishedAt: string;
// }

// export interface PostViewedPayload {
//   postId: string;
//   userId?: string;
//   ipHash: string;
// }

// export interface NewsletterSubscribedPayload {
//   subscriberId: string;
//   email: string;
//   categories: string[];
// }



// // src/types/index.ts

// import type { FastifyRequest } from "fastify";

// // ─────────────────────────────────────────────────────────────────────
// // JWT payload — issued by the Auth service
// // ─────────────────────────────────────────────────────────────────────

// export interface JWTPayload {
//   sub: string;          // userId
//   email: string;
//   role: UserRole;
//   schoolId?: string;
//   iat: number;
//   exp: number;
// }

// export type UserRole = "student" | "creator" | "editor" | "admin";

// // ─────────────────────────────────────────────────────────────────────
// // Augmented Fastify request with decoded user
// // ─────────────────────────────────────────────────────────────────────

// export interface AuthenticatedUser {
//   id: string;
//   email: string;
//   role: UserRole;
//   schoolId?: string;
// }

// declare module "fastify" {
//   interface FastifyRequest {
//     user?: AuthenticatedUser;
//   }
// }

// // ─────────────────────────────────────────────────────────────────────
// // Pagination
// // ─────────────────────────────────────────────────────────────────────

// export interface PaginationQuery {
//   page: number;
//   limit: number;
//   cursor?: string;  // cursor-based pagination for feeds
// }

// export interface PaginatedResponse<T> {
//   data: T[];
//   pagination: {
//     total: number;
//     page: number;
//     limit: number;
//     totalPages: number;
//     hasNext: boolean;
//     hasPrev: boolean;
//     nextCursor?: string;
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Canonical API response shapes
// // ─────────────────────────────────────────────────────────────────────

// export interface ApiSuccess<T = unknown> {
//   success: true;
//   data: T;
//   meta?: Record<string, unknown>;
// }

// export interface ApiError {
//   success: false;
//   error: {
//     code: string;
//     message: string;
//     details?: unknown;
//   };
// }

// export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// // ─────────────────────────────────────────────────────────────────────
// // RabbitMQ event envelopes (emitted by this service)
// // ─────────────────────────────────────────────────────────────────────

// export type BlogEventType =
//   | "blog.post.published"
//   | "blog.post.updated"
//   | "blog.post.deleted"
//   | "blog.comment.created"
//   | "blog.comment.approved"
//   | "blog.newsletter.subscribed"
//   | "blog.newsletter.unsubscribed"
//   | "blog.post.viewed";

// export interface BlogEvent<T = unknown> {
//   eventType: BlogEventType;
//   serviceSource: "blog-service";
//   timestamp: string;       // ISO 8601
//   payload: T;
// }

// // Specific event payloads
// export interface PostPublishedPayload {
//   postId: string;
//   slug: string;
//   title: string;
//   authorId: string;
//   categorySlug: string;
//   tags: string[];
//   publishedAt: string;
// }

// export interface PostViewedPayload {
//   postId: string;
//   userId?: string;
//   ipHash: string;
// }

// export interface NewsletterSubscribedPayload {
//   subscriberId: string;
//   email: string;
//   categories: string[];
// }