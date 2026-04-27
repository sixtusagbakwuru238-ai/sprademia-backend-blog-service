// src/modules/search/index.ts
// Full-text search across blog posts.
// Uses PostgreSQL's native full-text search via Prisma's `search` mode,
// with Redis caching for repeated queries.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { PostStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { cacheGet, cacheSet, CacheKeys } from "../../lib/redis";
import { config } from "../../config";

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const SearchQuerySchema = z.object({
  q:        z.string().min(2).max(200).transform((s) => s.trim()),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(30).default(10),
  category: z.string().optional(),
  tag:      z.string().optional(),
});

type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const SearchService = {
  async search(query: SearchQuery) {
    const cacheKey = CacheKeys.search(JSON.stringify(query));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Build Prisma where clause
    const where: Record<string, unknown> = {
      status: PostStatus.PUBLISHED,
      publishedAt: { lte: new Date() },
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { excerpt: { contains: query.q, mode: "insensitive" } },
        { content: { contains: query.q, mode: "insensitive" } },
      ],
    };

    if (query.category) {
      where["category"] = { slug: query.category };
    }

    if (query.tag) {
      where["tags"] = { some: { tag: { slug: query.tag } } };
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
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
          author: {
            select: {
              id: true,
              displayName: true,
              avatarUrl: true,
              verified: true,
            },
          },
          category: {
            select: { slug: true, name: true, emoji: true },
          },
          tags: {
            select: { tag: { select: { slug: true, name: true } } },
            take: 5,
          },
        },
        orderBy: [
          // Prioritise title matches by using relevance-like ordering
          { publishedAt: "desc" },
          { likeCount: "desc" },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    // Normalise tags
    const results = posts.map((p) => ({
      ...p,
      tags: (p.tags as Array<{ tag: { slug: string; name: string } }>)
        .map((pt) => pt.tag),
    }));

    const totalPages = Math.ceil(total / query.limit);
    const result = {
      data: results,
      query: query.q,
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      },
    };

    // Cache search results — shorter TTL since new posts should appear quickly
    await cacheSet(cacheKey, result, 120); // 2 minutes

    return result;
  },

  /** Autocomplete suggestions for the search input */
  async suggest(q: string) {
    if (q.length < 2) return [];

    // Return matching post titles (used for search dropdown)
    const posts = await prisma.post.findMany({
      where: {
        status: PostStatus.PUBLISHED,
        publishedAt: { lte: new Date() },
        title: { contains: q, mode: "insensitive" },
      },
      select: {
        slug: true,
        title: true,
        category: { select: { name: true } },
      },
      take: 6,
      orderBy: { viewCount: "desc" },
    });

    return posts.map((p) => ({
      type: "post" as const,
      slug: p.slug,
      label: p.title,
      meta: p.category.name,
    }));
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function search(request: FastifyRequest, reply: FastifyReply) {
  const query = SearchQuerySchema.parse(request.query);
  const result = await SearchService.search(query);
  return reply.send({ success: true, ...result });
}

async function suggest(
  request: FastifyRequest<{ Querystring: { q: string } }>,
  reply: FastifyReply
) {
  const q = z.string().min(2).max(100).parse(request.query.q);
  const data = await SearchService.suggest(q);
  return reply.send({ success: true, data });
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get("/search", search);
  fastify.get("/search/suggest", suggest);
}




// // src/modules/search/index.ts
// // Full-text search across blog posts.
// // Uses PostgreSQL's native full-text search via Prisma's `search` mode,
// // with Redis caching for repeated queries.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { cacheGet, cacheSet, CacheKeys } from "../../lib/redis";
// import { config } from "../../config";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const SearchQuerySchema = z.object({
//   q:        z.string().min(2).max(200).transform((s) => s.trim()),
//   page:     z.coerce.number().int().min(1).default(1),
//   limit:    z.coerce.number().int().min(1).max(30).default(10),
//   category: z.string().optional(),
//   tag:      z.string().optional(),
// });

// type SearchQuery = z.infer<typeof SearchQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const SearchService = {
//   async search(query: SearchQuery) {
//     const cacheKey = CacheKeys.search(JSON.stringify(query));
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     // Build Prisma where clause
//     const where: Record<string, unknown> = {
//       status: PostStatus.PUBLISHED,
//       publishedAt: { lte: new Date() },
//       OR: [
//         { title: { contains: query.q, mode: "insensitive" } },
//         { excerpt: { contains: query.q, mode: "insensitive" } },
//         { content: { contains: query.q, mode: "insensitive" } },
//       ],
//     };

//     if (query.category) {
//       where["category"] = { slug: query.category };
//     }

//     if (query.tag) {
//       where["tags"] = { some: { tag: { slug: query.tag } } };
//     }

//     const [total, posts] = await Promise.all([
//       prisma.post.count({ where }),
//       prisma.post.findMany({
//         where,
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
//           author: {
//             select: {
//               id: true,
//               displayName: true,
//               avatarUrl: true,
//               verified: true,
//             },
//           },
//           category: {
//             select: { slug: true, name: true, emoji: true },
//           },
//           tags: {
//             select: { tag: { select: { slug: true, name: true } } },
//             take: 5,
//           },
//         },
//         orderBy: [
//           // Prioritise title matches by using relevance-like ordering
//           { publishedAt: "desc" },
//           { likeCount: "desc" },
//         ],
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     // Normalise tags
//     const results = posts.map((p) => ({
//       ...p,
//       tags: (p.tags as Array<{ tag: { slug: string; name: string } }>)
//         .map((pt) => pt.tag),
//     }));

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: results,
//       query: query.q,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     // Cache search results — shorter TTL since new posts should appear quickly
//     await cacheSet(cacheKey, result, 120); // 2 minutes

//     return result;
//   },

//   /** Autocomplete suggestions for the search input */
//   async suggest(q: string) {
//     if (q.length < 2) return [];

//     // Return matching post titles (used for search dropdown)
//     const posts = await prisma.post.findMany({
//       where: {
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//         title: { contains: q, mode: "insensitive" },
//       },
//       select: {
//         slug: true,
//         title: true,
//         category: { select: { name: true } },
//       },
//       take: 6,
//       orderBy: { viewCount: "desc" },
//     });

//     return posts.map((p) => ({
//       type: "post" as const,
//       slug: p.slug,
//       label: p.title,
//       meta: p.category.name,
//     }));
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function search(request: FastifyRequest, reply: FastifyReply) {
//   const query = SearchQuerySchema.parse(request.query);
//   const result = await SearchService.search(query);
//   return reply.send({ success: true, ...result });
// }

// async function suggest(
//   request: FastifyRequest<{ Querystring: { q: string } }>,
//   reply: FastifyReply
// ) {
//   const q = z.string().min(2).max(100).parse(request.query.q);
//   const data = await SearchService.suggest(q);
//   return reply.send({ success: true, data });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function searchRoutes(fastify: FastifyInstance) {
//   fastify.get("/search", search);
//   fastify.get("/search/suggest", suggest);
// }



// // src/modules/search/index.ts
// // Full-text search across blog posts.
// // Uses PostgreSQL's native full-text search via Prisma's `search` mode,
// // with Redis caching for repeated queries.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { cacheGet, cacheSet, CacheKeys } from "../../lib/redis";
// import { config } from "../../config";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const SearchQuerySchema = z.object({
//   q:        z.string().min(2).max(200).transform((s) => s.trim()),
//   page:     z.coerce.number().int().min(1).default(1),
//   limit:    z.coerce.number().int().min(1).max(30).default(10),
//   category: z.string().optional(),
//   tag:      z.string().optional(),
// });

// type SearchQuery = z.infer<typeof SearchQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const SearchService = {
//   async search(query: SearchQuery) {
//     const cacheKey = CacheKeys.search(JSON.stringify(query));
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     // Build Prisma where clause
//     const where: Record<string, unknown> = {
//       status: PostStatus.PUBLISHED,
//       publishedAt: { lte: new Date() },
//       OR: [
//         { title: { contains: query.q, mode: "insensitive" } },
//         { excerpt: { contains: query.q, mode: "insensitive" } },
//         { content: { contains: query.q, mode: "insensitive" } },
//       ],
//     };

//     if (query.category) {
//       where["category"] = { slug: query.category };
//     }

//     if (query.tag) {
//       where["tags"] = { some: { tag: { slug: query.tag } } };
//     }

//     const [total, posts] = await Promise.all([
//       prisma.post.count({ where }),
//       prisma.post.findMany({
//         where,
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
//           author: {
//             select: {
//               id: true,
//               displayName: true,
//               avatarUrl: true,
//               verified: true,
//             },
//           },
//           category: {
//             select: { slug: true, name: true, emoji: true },
//           },
//           tags: {
//             select: { tag: { select: { slug: true, name: true } } },
//             take: 5,
//           },
//         },
//         orderBy: [
//           // Prioritise title matches by using relevance-like ordering
//           { publishedAt: "desc" },
//           { likeCount: "desc" },
//         ],
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     // Normalise tags
//     const results = posts.map((p) => ({
//       ...p,
//       tags: (p.tags as Array<{ tag: { slug: string; name: string } }>)
//         .map((pt) => pt.tag),
//     }));

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: results,
//       query: query.q,
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     // Cache search results — shorter TTL since new posts should appear quickly
//     await cacheSet(cacheKey, result, 120); // 2 minutes

//     return result;
//   },

//   /** Autocomplete suggestions for the search input */
//   async suggest(q: string) {
//     if (q.length < 2) return [];

//     // Return matching post titles (used for search dropdown)
//     const posts = await prisma.post.findMany({
//       where: {
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//         title: { contains: q, mode: "insensitive" },
//       },
//       select: {
//         slug: true,
//         title: true,
//         category: { select: { name: true } },
//       },
//       take: 6,
//       orderBy: { viewCount: "desc" },
//     });

//     return posts.map((p) => ({
//       type: "post" as const,
//       slug: p.slug,
//       label: p.title,
//       meta: p.category.name,
//     }));
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function search(request: FastifyRequest, reply: FastifyReply) {
//   const query = SearchQuerySchema.parse(request.query);
//   const result = await SearchService.search(query);
//   return reply.send({ success: true, ...result });
// }

// async function suggest(
//   request: FastifyRequest<{ Querystring: { q: string } }>,
//   reply: FastifyReply
// ) {
//   const q = z.string().min(2).max(100).parse(request.query.q);
//   const data = await SearchService.suggest(q);
//   return reply.send({ success: true, data });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function searchRoutes(fastify: FastifyInstance) {
//   fastify.get("/search", search);
//   fastify.get("/search/suggest", suggest);
// }