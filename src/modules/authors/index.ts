// src/modules/authors/index.ts
// Author profiles are owned by the Auth/User service.
// This module syncs a lightweight copy here for JOIN queries and
// exposes read-only endpoints for the blog frontend.
// Mutation happens via RabbitMQ events (user.profile.updated).

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { PostStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireInternalKey } from "../../middleware/auth";

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

// Used by internal sync endpoint (called by Auth service or event consumer)
const UpsertAuthorSchema = z.object({
  id:            z.string(),
  displayName:   z.string().max(100),
  avatarUrl:     z.string().url().optional().nullable(),
  bio:           z.string().max(500).optional().nullable(),
  school:        z.string().max(100).optional().nullable(),
  role:          z.string().max(60).optional().nullable(),
  twitterHandle: z.string().max(60).optional().nullable(),
  gradient:      z.string().max(100).optional().nullable(), // Tailwind gradient class
  verified:      z.boolean().default(false),
});

type UpsertAuthorInput = z.infer<typeof UpsertAuthorSchema>;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const AuthorsService = {
  async getById(id: string) {
    return prisma.author.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        school: true,
        role: true,
        twitterHandle: true,
        verified: true,
        _count: {
          select: {
            posts: {
              where: {
                status: PostStatus.PUBLISHED,
                publishedAt: { lte: new Date() },
              },
            },
          },
        },
      },
    });
  },

  async getPostsByAuthor(
    authorId: string,
    page: number,
    limit: number
  ) {
    const [total, posts] = await Promise.all([
      prisma.post.count({
        where: {
          authorId,
          status: PostStatus.PUBLISHED,
          publishedAt: { lte: new Date() },
        },
      }),
      prisma.post.findMany({
        where: {
          authorId,
          status: PostStatus.PUBLISHED,
          publishedAt: { lte: new Date() },
        },
        select: {
          id: true,
          slug: true,
          title: true,
          excerpt: true,
          coverEmoji: true,
          coverGradient: true,
          readTimeMinutes: true,
          publishedAt: true,
          likeCount: true,
          viewCount: true,
          category: { select: { slug: true, name: true, emoji: true } },
          tags: { select: { tag: { select: { slug: true, name: true } } }, take: 4 },
        },
        orderBy: { publishedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      data: posts.map((p) => ({
        ...p,
        tags: (p.tags as Array<{ tag: { slug: string; name: string } }>).map((pt) => pt.tag),
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  },

  /** Upsert — called by internal sync from Auth service */
  async upsert(input: UpsertAuthorInput) {
    return prisma.author.upsert({
      where: { id: input.id },
      create: input,
      update: {
        displayName:   input.displayName,
        avatarUrl:     input.avatarUrl,
        bio:           input.bio,
        school:        input.school,
        role:          input.role,
        twitterHandle: input.twitterHandle,
        gradient:      input.gradient,
        verified:      input.verified,
      },
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function getAuthor(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const author = await AuthorsService.getById(request.params.id);
  if (!author) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Author not found" },
    });
  }
  return reply.send({
    success: true,
    data: {
      ...author,
      postCount: author._count.posts,
      _count: undefined,
    },
  });
}

async function getAuthorPosts(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { page, limit } = z
    .object({
      page:  z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(12),
    })
    .parse(request.query);

  const result = await AuthorsService.getPostsByAuthor(
    request.params.id,
    page,
    limit
  );
  return reply.send({ success: true, ...result });
}

/** Internal endpoint — called by Auth service or event consumer */
async function upsertAuthor(request: FastifyRequest, reply: FastifyReply) {
  const input = UpsertAuthorSchema.parse(request.body);
  const author = await AuthorsService.upsert(input);
  return reply.send({ success: true, data: author });
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function authorsRoutes(fastify: FastifyInstance) {
  // Public
  fastify.get<{ Params: { id: string } }>("/authors/:id", getAuthor);
  fastify.get<{ Params: { id: string } }>("/authors/:id/posts", getAuthorPosts);

  // Internal — only reachable with the shared internal API key
  fastify.put(
    "/internal/authors",
    { preHandler: [requireInternalKey] },
    upsertAuthor
  );
}



// // src/modules/authors/index.ts
// // Author profiles are owned by the Auth/User service.
// // This module syncs a lightweight copy here for JOIN queries and
// // exposes read-only endpoints for the blog frontend.
// // Mutation happens via RabbitMQ events (user.profile.updated).

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { requireInternalKey } from "../../middleware/auth";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// // Used by internal sync endpoint (called by Auth service or event consumer)
// const UpsertAuthorSchema = z.object({
//   id:            z.string(),
//   displayName:   z.string().max(100),
//   avatarUrl:     z.string().url().optional().nullable(),
//   bio:           z.string().max(500).optional().nullable(),
//   school:        z.string().max(100).optional().nullable(),
//   role:          z.string().max(60).optional().nullable(),
//   twitterHandle: z.string().max(60).optional().nullable(),
//   gradient:      z.string().max(100).optional().nullable(), // Tailwind gradient class
//   verified:      z.boolean().default(false),
// });

// type UpsertAuthorInput = z.infer<typeof UpsertAuthorSchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const AuthorsService = {
//   async getById(id: string) {
//     return prisma.author.findUnique({
//       where: { id },
//       select: {
//         id: true,
//         displayName: true,
//         avatarUrl: true,
//         bio: true,
//         school: true,
//         role: true,
//         twitterHandle: true,
//         verified: true,
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 status: PostStatus.PUBLISHED,
//                 publishedAt: { lte: new Date() },
//               },
//             },
//           },
//         },
//       },
//     });
//   },

//   async getPostsByAuthor(
//     authorId: string,
//     page: number,
//     limit: number
//   ) {
//     const [total, posts] = await Promise.all([
//       prisma.post.count({
//         where: {
//           authorId,
//           status: PostStatus.PUBLISHED,
//           publishedAt: { lte: new Date() },
//         },
//       }),
//       prisma.post.findMany({
//         where: {
//           authorId,
//           status: PostStatus.PUBLISHED,
//           publishedAt: { lte: new Date() },
//         },
//         select: {
//           id: true,
//           slug: true,
//           title: true,
//           excerpt: true,
//           coverEmoji: true,
//           coverGradient: true,
//           readTimeMinutes: true,
//           publishedAt: true,
//           likeCount: true,
//           viewCount: true,
//           category: { select: { slug: true, name: true, emoji: true } },
//           tags: { select: { tag: { select: { slug: true, name: true } } }, take: 4 },
//         },
//         orderBy: { publishedAt: "desc" },
//         skip: (page - 1) * limit,
//         take: limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / limit);
//     return {
//       data: posts.map((p) => ({
//         ...p,
//         tags: (p.tags as Array<{ tag: { slug: string; name: string } }>).map((pt) => pt.tag),
//       })),
//       pagination: {
//         total,
//         page,
//         limit,
//         totalPages,
//         hasNext: page < totalPages,
//         hasPrev: page > 1,
//       },
//     };
//   },

//   /** Upsert — called by internal sync from Auth service */
//   async upsert(input: UpsertAuthorInput) {
//     return prisma.author.upsert({
//       where: { id: input.id },
//       create: input,
//       update: {
//         displayName:   input.displayName,
//         avatarUrl:     input.avatarUrl,
//         bio:           input.bio,
//         school:        input.school,
//         role:          input.role,
//         twitterHandle: input.twitterHandle,
//         gradient:      input.gradient,
//         verified:      input.verified,
//       },
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function getAuthor(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const author = await AuthorsService.getById(request.params.id);
//   if (!author) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Author not found" },
//     });
//   }
//   return reply.send({
//     success: true,
//     data: {
//       ...author,
//       postCount: author._count.posts,
//       _count: undefined,
//     },
//   });
// }

// async function getAuthorPosts(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const { page, limit } = z
//     .object({
//       page:  z.coerce.number().int().min(1).default(1),
//       limit: z.coerce.number().int().min(1).max(50).default(12),
//     })
//     .parse(request.query);

//   const result = await AuthorsService.getPostsByAuthor(
//     request.params.id,
//     page,
//     limit
//   );
//   return reply.send({ success: true, ...result });
// }

// /** Internal endpoint — called by Auth service or event consumer */
// async function upsertAuthor(request: FastifyRequest, reply: FastifyReply) {
//   const input = UpsertAuthorSchema.parse(request.body);
//   const author = await AuthorsService.upsert(input);
//   return reply.send({ success: true, data: author });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function authorsRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.get<{ Params: { id: string } }>("/authors/:id", getAuthor);
//   fastify.get<{ Params: { id: string } }>("/authors/:id/posts", getAuthorPosts);

//   // Internal — only reachable with the shared internal API key
//   fastify.put(
//     "/internal/authors",
//     { preHandler: [requireInternalKey] },
//     upsertAuthor
//   );
// }



// // src/modules/authors/index.ts
// // Author profiles are owned by the Auth/User service.
// // This module syncs a lightweight copy here for JOIN queries and
// // exposes read-only endpoints for the blog frontend.
// // Mutation happens via RabbitMQ events (user.profile.updated).

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { requireInternalKey } from "../../middleware/auth";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// // Used by internal sync endpoint (called by Auth service or event consumer)
// const UpsertAuthorSchema = z.object({
//   id:            z.string(),
//   displayName:   z.string().max(100),
//   avatarUrl:     z.string().url().optional().nullable(),
//   bio:           z.string().max(500).optional().nullable(),
//   school:        z.string().max(100).optional().nullable(),
//   role:          z.string().max(60).optional().nullable(),
//   twitterHandle: z.string().max(60).optional().nullable(),
//   verified:      z.boolean().default(false),
// });

// type UpsertAuthorInput = z.infer<typeof UpsertAuthorSchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const AuthorsService = {
//   async getById(id: string) {
//     return prisma.author.findUnique({
//       where: { id },
//       select: {
//         id: true,
//         displayName: true,
//         avatarUrl: true,
//         bio: true,
//         school: true,
//         role: true,
//         twitterHandle: true,
//         verified: true,
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 status: PostStatus.PUBLISHED,
//                 publishedAt: { lte: new Date() },
//               },
//             },
//           },
//         },
//       },
//     });
//   },

//   async getPostsByAuthor(
//     authorId: string,
//     page: number,
//     limit: number
//   ) {
//     const [total, posts] = await Promise.all([
//       prisma.post.count({
//         where: {
//           authorId,
//           status: PostStatus.PUBLISHED,
//           publishedAt: { lte: new Date() },
//         },
//       }),
//       prisma.post.findMany({
//         where: {
//           authorId,
//           status: PostStatus.PUBLISHED,
//           publishedAt: { lte: new Date() },
//         },
//         select: {
//           id: true,
//           slug: true,
//           title: true,
//           excerpt: true,
//           coverEmoji: true,
//           coverGradient: true,
//           readTimeMinutes: true,
//           publishedAt: true,
//           likeCount: true,
//           viewCount: true,
//           category: { select: { slug: true, name: true, emoji: true } },
//           tags: { select: { tag: { select: { slug: true, name: true } } }, take: 4 },
//         },
//         orderBy: { publishedAt: "desc" },
//         skip: (page - 1) * limit,
//         take: limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / limit);
//     return {
//       data: posts.map((p) => ({
//         ...p,
//         tags: (p.tags as Array<{ tag: { slug: string; name: string } }>).map((pt) => pt.tag),
//       })),
//       pagination: {
//         total,
//         page,
//         limit,
//         totalPages,
//         hasNext: page < totalPages,
//         hasPrev: page > 1,
//       },
//     };
//   },

//   /** Upsert — called by internal sync from Auth service */
//   async upsert(input: UpsertAuthorInput) {
//     return prisma.author.upsert({
//       where: { id: input.id },
//       create: input,
//       update: {
//         displayName:   input.displayName,
//         avatarUrl:     input.avatarUrl,
//         bio:           input.bio,
//         school:        input.school,
//         role:          input.role,
//         twitterHandle: input.twitterHandle,
//         verified:      input.verified,
//       },
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function getAuthor(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const author = await AuthorsService.getById(request.params.id);
//   if (!author) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Author not found" },
//     });
//   }
//   return reply.send({
//     success: true,
//     data: {
//       ...author,
//       postCount: author._count.posts,
//       _count: undefined,
//     },
//   });
// }

// async function getAuthorPosts(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const { page, limit } = z
//     .object({
//       page:  z.coerce.number().int().min(1).default(1),
//       limit: z.coerce.number().int().min(1).max(50).default(12),
//     })
//     .parse(request.query);

//   const result = await AuthorsService.getPostsByAuthor(
//     request.params.id,
//     page,
//     limit
//   );
//   return reply.send({ success: true, ...result });
// }

// /** Internal endpoint — called by Auth service or event consumer */
// async function upsertAuthor(request: FastifyRequest, reply: FastifyReply) {
//   const input = UpsertAuthorSchema.parse(request.body);
//   const author = await AuthorsService.upsert(input);
//   return reply.send({ success: true, data: author });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function authorsRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.get<{ Params: { id: string } }>("/authors/:id", getAuthor);
//   fastify.get<{ Params: { id: string } }>("/authors/:id/posts", getAuthorPosts);

//   // Internal — only reachable with the shared internal API key
//   fastify.put(
//     "/internal/authors",
//     { preHandler: [requireInternalKey] },
//     upsertAuthor
//   );
// }