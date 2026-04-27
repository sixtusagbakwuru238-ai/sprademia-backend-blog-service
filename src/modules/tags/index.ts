// src/modules/tags/index.ts

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { cacheGet, cacheSet, cacheDelete, CacheKeys } from "../../lib/redis";
import { toSlug } from "../../lib/content";
import { authenticate, requireEditor } from "../../middleware/auth";
import { config } from "../../config";

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const CreateTagSchema = z.object({
  name: z.string().min(1).max(60),
});

const ListTagsQuerySchema = z.object({
  popular: z.coerce.boolean().optional(),
  limit:   z.coerce.number().int().min(1).max(200).default(100),
  search:  z.string().max(60).optional(),
});

type CreateTagInput = z.infer<typeof CreateTagSchema>;
type ListTagsQuery  = z.infer<typeof ListTagsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const TagsService = {
  async list(query: ListTagsQuery) {
    const cacheKey = query.popular ? CacheKeys.popularTags() : CacheKeys.tags();
    const cached = await cacheGet(cacheKey);
    if (cached && !query.search) return cached;

    if (query.popular) {
      // Tags ordered by how many published posts reference them
      const tags = await prisma.tag.findMany({
        where: query.search
          ? { name: { contains: query.search, mode: "insensitive" } }
          : undefined,
        include: {
          _count: {
            select: {
              posts: {
                where: {
                  post: {
                    status: "PUBLISHED",
                    publishedAt: { lte: new Date() },
                  },
                },
              },
            },
          },
        },
        orderBy: { posts: { _count: "desc" } },
        take: query.limit,
      });

      const result = tags.map((t) => ({
        ...t,
        postCount: t._count.posts,
        _count: undefined,
      }));

      if (!query.search) {
        await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
      }
      return result;
    }

    // All tags alphabetically
    const tags = await prisma.tag.findMany({
      where: query.search
        ? { name: { contains: query.search, mode: "insensitive" } }
        : undefined,
      orderBy: { name: "asc" },
      take: query.limit,
      include: {
        _count: {
          select: {
            posts: {
              where: {
                post: {
                  status: "PUBLISHED",
                  publishedAt: { lte: new Date() },
                },
              },
            },
          },
        },
      },
    });

    const result = tags.map((t) => ({
      ...t,
      postCount: t._count.posts,
      _count: undefined,
    }));

    if (!query.search) {
      await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
    }
    return result;
  },

  async getBySlug(slug: string) {
    const cached = await cacheGet(CacheKeys.tag(slug));
    if (cached) return cached;

    const tag = await prisma.tag.findUnique({
      where: { slug },
      include: {
        _count: {
          select: {
            posts: {
              where: {
                post: {
                  status: "PUBLISHED",
                  publishedAt: { lte: new Date() },
                },
              },
            },
          },
        },
      },
    });

    if (!tag) return null;

    const result = { ...tag, postCount: tag._count.posts, _count: undefined };
    await cacheSet(CacheKeys.tag(slug), result, config.CACHE_TTL_TAGS);
    return result;
  },

  /** Find or create — used when writers type free-form tags */
  async findOrCreate(name: string) {
    const slug = toSlug(name);
    const normalised = name.trim();

    const existing = await prisma.tag.findUnique({ where: { slug } });
    if (existing) return existing;

    return prisma.tag.create({ data: { name: normalised, slug } });
  },

  async create(input: CreateTagInput) {
    const slug = toSlug(input.name);
    const existing = await prisma.tag.findUnique({ where: { slug } });
    if (existing) {
      throw Object.assign(
        new Error(`Tag "${input.name}" already exists`),
        { code: "CONFLICT" }
      );
    }

    const tag = await prisma.tag.create({
      data: { name: input.name.trim(), slug },
    });

    await Promise.all([
      cacheDelete(CacheKeys.tags()),
      cacheDelete(CacheKeys.popularTags()),
    ]);

    return tag;
  },

  async delete(id: string) {
    const tag = await prisma.tag.findUnique({
      where: { id },
      select: { slug: true, _count: { select: { posts: true } } },
    });
    if (!tag) return null;

    if (tag._count.posts > 0) {
      throw Object.assign(
        new Error(`Cannot delete tag used by ${tag._count.posts} posts`),
        { code: "CONFLICT" }
      );
    }

    await prisma.tag.delete({ where: { id } });
    await Promise.all([
      cacheDelete(CacheKeys.tags()),
      cacheDelete(CacheKeys.popularTags()),
      cacheDelete(CacheKeys.tag(tag.slug)),
    ]);
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function listTags(request: FastifyRequest, reply: FastifyReply) {
  const query = ListTagsQuerySchema.parse(request.query);
  const data = await TagsService.list(query);
  return reply.send({ success: true, data });
}

async function getTag(
  request: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply
) {
  const data = await TagsService.getBySlug(request.params.slug);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Tag not found" },
    });
  }
  return reply.send({ success: true, data });
}

async function createTag(request: FastifyRequest, reply: FastifyReply) {
  const input = CreateTagSchema.parse(request.body);
  const data = await TagsService.create(input);
  return reply.code(201).send({ success: true, data });
}

async function deleteTag(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  await TagsService.delete(request.params.id);
  return reply.code(204).send();
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function tagsRoutes(fastify: FastifyInstance) {
  fastify.get("/tags", listTags);
  fastify.get<{ Params: { slug: string } }>("/tags/:slug", getTag);

  fastify.post(
    "/tags",
    { preHandler: [authenticate, requireEditor] },
    createTag
  );
  fastify.delete<{ Params: { id: string } }>(
    "/tags/:id",
    { preHandler: [authenticate, requireEditor] },
    deleteTag
  );
}



// // src/modules/tags/index.ts

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { prisma } from "../../lib/prisma";
// import { cacheGet, cacheSet, cacheDelete, CacheKeys } from "../../lib/redis";
// import { toSlug } from "../../lib/content";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import { config } from "../../config";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreateTagSchema = z.object({
//   name: z.string().min(1).max(60),
// });

// const ListTagsQuerySchema = z.object({
//   popular: z.coerce.boolean().optional(),
//   limit:   z.coerce.number().int().min(1).max(200).default(100),
//   search:  z.string().max(60).optional(),
// });

// type CreateTagInput = z.infer<typeof CreateTagSchema>;
// type ListTagsQuery  = z.infer<typeof ListTagsQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const TagsService = {
//   async list(query: ListTagsQuery) {
//     const cacheKey = query.popular ? CacheKeys.popularTags() : CacheKeys.tags();
//     const cached = await cacheGet(cacheKey);
//     if (cached && !query.search) return cached;

//     if (query.popular) {
//       // Tags ordered by how many published posts reference them
//       const tags = await prisma.tag.findMany({
//         where: query.search
//           ? { name: { contains: query.search, mode: "insensitive" } }
//           : undefined,
//         include: {
//           _count: {
//             select: {
//               posts: {
//                 where: {
//                   post: {
//                     status: "PUBLISHED",
//                     publishedAt: { lte: new Date() },
//                   },
//                 },
//               },
//             },
//           },
//         },
//         orderBy: { posts: { _count: "desc" } },
//         take: query.limit,
//       });

//       const result = tags.map((t) => ({
//         ...t,
//         postCount: t._count.posts,
//         _count: undefined,
//       }));

//       if (!query.search) {
//         await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
//       }
//       return result;
//     }

//     // All tags alphabetically
//     const tags = await prisma.tag.findMany({
//       where: query.search
//         ? { name: { contains: query.search, mode: "insensitive" } }
//         : undefined,
//       orderBy: { name: "asc" },
//       take: query.limit,
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 post: {
//                   status: "PUBLISHED",
//                   publishedAt: { lte: new Date() },
//                 },
//               },
//             },
//           },
//         },
//       },
//     });

//     const result = tags.map((t) => ({
//       ...t,
//       postCount: t._count.posts,
//       _count: undefined,
//     }));

//     if (!query.search) {
//       await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
//     }
//     return result;
//   },

//   async getBySlug(slug: string) {
//     const cached = await cacheGet(CacheKeys.tag(slug));
//     if (cached) return cached;

//     const tag = await prisma.tag.findUnique({
//       where: { slug },
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 post: {
//                   status: "PUBLISHED",
//                   publishedAt: { lte: new Date() },
//                 },
//               },
//             },
//           },
//         },
//       },
//     });

//     if (!tag) return null;

//     const result = { ...tag, postCount: tag._count.posts, _count: undefined };
//     await cacheSet(CacheKeys.tag(slug), result, config.CACHE_TTL_TAGS);
//     return result;
//   },

//   /** Find or create — used when writers type free-form tags */
//   async findOrCreate(name: string) {
//     const slug = toSlug(name);
//     const normalised = name.trim();

//     const existing = await prisma.tag.findUnique({ where: { slug } });
//     if (existing) return existing;

//     return prisma.tag.create({ data: { name: normalised, slug } });
//   },

//   async create(input: CreateTagInput) {
//     const slug = toSlug(input.name);
//     const existing = await prisma.tag.findUnique({ where: { slug } });
//     if (existing) {
//       throw Object.assign(
//         new Error(`Tag "${input.name}" already exists`),
//         { code: "CONFLICT" }
//       );
//     }

//     const tag = await prisma.tag.create({
//       data: { name: input.name.trim(), slug },
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.tags()),
//       cacheDelete(CacheKeys.popularTags()),
//     ]);

//     return tag;
//   },

//   async delete(id: string) {
//     const tag = await prisma.tag.findUnique({
//       where: { id },
//       select: { slug: true, _count: { select: { posts: true } } },
//     });
//     if (!tag) return null;

//     if (tag._count.posts > 0) {
//       throw Object.assign(
//         new Error(`Cannot delete tag used by ${tag._count.posts} posts`),
//         { code: "CONFLICT" }
//       );
//     }

//     await prisma.tag.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.tags()),
//       cacheDelete(CacheKeys.popularTags()),
//       cacheDelete(CacheKeys.tag(tag.slug)),
//     ]);
//     return true;
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listTags(request: FastifyRequest, reply: FastifyReply) {
//   const query = ListTagsQuerySchema.parse(request.query);
//   const data = await TagsService.list(query);
//   return reply.send({ success: true, data });
// }

// async function getTag(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await TagsService.getBySlug(request.params.slug);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Tag not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function createTag(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreateTagSchema.parse(request.body);
//   const data = await TagsService.create(input);
//   return reply.code(201).send({ success: true, data });
// }

// async function deleteTag(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   await TagsService.delete(request.params.id);
//   return reply.code(204).send();
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function tagsRoutes(fastify: FastifyInstance) {
//   fastify.get("/tags", listTags);
//   fastify.get<{ Params: { slug: string } }>("/tags/:slug", getTag);

//   fastify.post(
//     "/tags",
//     { preHandler: [authenticate, requireEditor] },
//     createTag
//   );
//   fastify.delete<{ Params: { id: string } }>(
//     "/tags/:id",
//     { preHandler: [authenticate, requireEditor] },
//     deleteTag
//   );
// }



// // src/modules/tags/index.ts

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { prisma } from "../../lib/prisma";
// import { cacheGet, cacheSet, cacheDelete, CacheKeys } from "../../lib/redis";
// import { toSlug } from "../../lib/content";
// import { authenticate, requireEditor } from "../../middleware/auth";
// import { config } from "../../config";

// // ─────────────────────────────────────────────────────────────────────
// // Schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreateTagSchema = z.object({
//   name: z.string().min(1).max(60),
// });

// const ListTagsQuerySchema = z.object({
//   popular: z.coerce.boolean().optional(),
//   limit:   z.coerce.number().int().min(1).max(200).default(100),
//   search:  z.string().max(60).optional(),
// });

// type CreateTagInput = z.infer<typeof CreateTagSchema>;
// type ListTagsQuery  = z.infer<typeof ListTagsQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const TagsService = {
//   async list(query: ListTagsQuery) {
//     const cacheKey = query.popular ? CacheKeys.popularTags() : CacheKeys.tags();
//     const cached = await cacheGet(cacheKey);
//     if (cached && !query.search) return cached;

//     if (query.popular) {
//       // Tags ordered by how many published posts reference them
//       const tags = await prisma.tag.findMany({
//         where: query.search
//           ? { name: { contains: query.search, mode: "insensitive" } }
//           : undefined,
//         include: {
//           _count: {
//             select: {
//               posts: {
//                 where: {
//                   post: {
//                     status: "PUBLISHED",
//                     publishedAt: { lte: new Date() },
//                   },
//                 },
//               },
//             },
//           },
//         },
//         orderBy: { posts: { _count: "desc" } },
//         take: query.limit,
//       });

//       const result = tags.map((t) => ({
//         ...t,
//         postCount: t._count.posts,
//         _count: undefined,
//       }));

//       if (!query.search) {
//         await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
//       }
//       return result;
//     }

//     // All tags alphabetically
//     const tags = await prisma.tag.findMany({
//       where: query.search
//         ? { name: { contains: query.search, mode: "insensitive" } }
//         : undefined,
//       orderBy: { name: "asc" },
//       take: query.limit,
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 post: {
//                   status: "PUBLISHED",
//                   publishedAt: { lte: new Date() },
//                 },
//               },
//             },
//           },
//         },
//       },
//     });

//     const result = tags.map((t) => ({
//       ...t,
//       postCount: t._count.posts,
//       _count: undefined,
//     }));

//     if (!query.search) {
//       await cacheSet(cacheKey, result, config.CACHE_TTL_TAGS);
//     }
//     return result;
//   },

//   async getBySlug(slug: string) {
//     const cached = await cacheGet(CacheKeys.tag(slug));
//     if (cached) return cached;

//     const tag = await prisma.tag.findUnique({
//       where: { slug },
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: {
//                 post: {
//                   status: "PUBLISHED",
//                   publishedAt: { lte: new Date() },
//                 },
//               },
//             },
//           },
//         },
//       },
//     });

//     if (!tag) return null;

//     const result = { ...tag, postCount: tag._count.posts, _count: undefined };
//     await cacheSet(CacheKeys.tag(slug), result, config.CACHE_TTL_TAGS);
//     return result;
//   },

//   /** Find or create — used when writers type free-form tags */
//   async findOrCreate(name: string) {
//     const slug = toSlug(name);
//     const normalised = name.trim();

//     const existing = await prisma.tag.findUnique({ where: { slug } });
//     if (existing) return existing;

//     return prisma.tag.create({ data: { name: normalised, slug } });
//   },

//   async create(input: CreateTagInput) {
//     const slug = toSlug(input.name);
//     const existing = await prisma.tag.findUnique({ where: { slug } });
//     if (existing) {
//       throw Object.assign(
//         new Error(`Tag "${input.name}" already exists`),
//         { code: "CONFLICT" }
//       );
//     }

//     const tag = await prisma.tag.create({
//       data: { name: input.name.trim(), slug },
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.tags()),
//       cacheDelete(CacheKeys.popularTags()),
//     ]);

//     return tag;
//   },

//   async delete(id: string) {
//     const tag = await prisma.tag.findUnique({
//       where: { id },
//       select: { slug: true, _count: { select: { posts: true } } },
//     });
//     if (!tag) return null;

//     if (tag._count.posts > 0) {
//       throw Object.assign(
//         new Error(`Cannot delete tag used by ${tag._count.posts} posts`),
//         { code: "CONFLICT" }
//       );
//     }

//     await prisma.tag.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.tags()),
//       cacheDelete(CacheKeys.popularTags()),
//       cacheDelete(CacheKeys.tag(tag.slug)),
//     ]);
//     return true;
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listTags(request: FastifyRequest, reply: FastifyReply) {
//   const query = ListTagsQuerySchema.parse(request.query);
//   const data = await TagsService.list(query);
//   return reply.send({ success: true, data });
// }

// async function getTag(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await TagsService.getBySlug(request.params.slug);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Tag not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function createTag(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreateTagSchema.parse(request.body);
//   const data = await TagsService.create(input);
//   return reply.code(201).send({ success: true, data });
// }

// async function deleteTag(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   await TagsService.delete(request.params.id);
//   return reply.code(204).send();
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function tagsRoutes(fastify: FastifyInstance) {
//   fastify.get("/tags", listTags);
//   fastify.get<{ Params: { slug: string } }>("/tags/:slug", getTag);

//   fastify.post(
//     "/tags",
//     { preHandler: [authenticate, requireEditor] },
//     createTag
//   );
//   fastify.delete<{ Params: { id: string } }>(
//     "/tags/:id",
//     { preHandler: [authenticate, requireEditor] },
//     deleteTag
//   );
// }