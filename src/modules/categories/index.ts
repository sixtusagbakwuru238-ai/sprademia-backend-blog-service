// src/modules/categories/index.ts

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

const CreateCategorySchema = z.object({
  name:           z.string().min(2).max(60),
  description:    z.string().max(500).optional(),
  seoDescription: z.string().max(160).optional(),
  coverGradient:  z.string().max(120).optional(),
  emoji:          z.string().max(4).optional(),
  sortOrder:      z.coerce.number().int().min(0).default(0),
});

const UpdateCategorySchema = CreateCategorySchema.partial();

type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;
type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const CategoriesService = {
  async list() {
    const cached = await cacheGet(CacheKeys.categories());
    if (cached) return cached;

    const categories = await prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        _count: {
          select: {
            posts: {
              where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
            },
          },
        },
      },
    });

    const result = categories.map((c) => ({
      ...c,
      postCount: c._count.posts,
      _count: undefined,
    }));

    await cacheSet(CacheKeys.categories(), result, config.CACHE_TTL_CATEGORIES);
    return result;
  },

  async getBySlug(slug: string) {
    const cached = await cacheGet(CacheKeys.category(slug));
    if (cached) return cached;

    const category = await prisma.category.findUnique({
      where: { slug },
      include: {
        _count: {
          select: {
            posts: {
              where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
            },
          },
        },
      },
    });

    if (!category) return null;

    const result = {
      ...category,
      postCount: category._count.posts,
      _count: undefined,
    };

    await cacheSet(CacheKeys.category(slug), result, config.CACHE_TTL_CATEGORIES);
    return result;
  },

  async create(input: CreateCategoryInput) {
    const slug = toSlug(input.name);

    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) {
      throw Object.assign(
        new Error(`Category with slug "${slug}" already exists`),
        { code: "CONFLICT" }
      );
    }

    const category = await prisma.category.create({
      data: { ...input, slug },
    });

    await cacheDelete(CacheKeys.categories());
    return category;
  },

  async update(id: string, input: UpdateCategoryInput) {
    const existing = await prisma.category.findUnique({
      where: { id },
      select: { slug: true, name: true },
    });
    if (!existing) return null;

    let slug: string | undefined;
    if (input.name && input.name !== existing.name) {
      slug = toSlug(input.name);
      const conflict = await prisma.category.findFirst({
        where: { slug, id: { not: id } },
      });
      if (conflict) {
        throw Object.assign(
          new Error(`Category with slug "${slug}" already exists`),
          { code: "CONFLICT" }
        );
      }
    }

    const category = await prisma.category.update({
      where: { id },
      data: { ...input, ...(slug && { slug }) },
    });

    await Promise.all([
      cacheDelete(CacheKeys.categories()),
      cacheDelete(CacheKeys.category(existing.slug)),
      slug ? cacheDelete(CacheKeys.category(slug)) : Promise.resolve(),
    ]);

    return category;
  },

  async delete(id: string) {
    const category = await prisma.category.findUnique({
      where: { id },
      select: { slug: true, _count: { select: { posts: true } } },
    });
    if (!category) return null;

    if (category._count.posts > 0) {
      throw Object.assign(
        new Error(
          `Cannot delete category with ${category._count.posts} posts. Reassign posts first.`
        ),
        { code: "CONFLICT" }
      );
    }

    await prisma.category.delete({ where: { id } });
    await Promise.all([
      cacheDelete(CacheKeys.categories()),
      cacheDelete(CacheKeys.category(category.slug)),
    ]);
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function listCategories(_req: FastifyRequest, reply: FastifyReply) {
  const data = await CategoriesService.list();
  return reply.send({ success: true, data });
}

async function getCategory(
  request: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply
) {
  const data = await CategoriesService.getBySlug(request.params.slug);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Category not found" },
    });
  }
  return reply.send({ success: true, data });
}

async function createCategory(request: FastifyRequest, reply: FastifyReply) {
  const input = CreateCategorySchema.parse(request.body);
  const data = await CategoriesService.create(input);
  return reply.code(201).send({ success: true, data });
}

async function updateCategory(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const input = UpdateCategorySchema.parse(request.body);
  const data = await CategoriesService.update(request.params.id, input);
  if (!data) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Category not found" },
    });
  }
  return reply.send({ success: true, data });
}

async function deleteCategory(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  await CategoriesService.delete(request.params.id);
  return reply.code(204).send();
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function categoriesRoutes(fastify: FastifyInstance) {
  // Public
  fastify.get("/categories", listCategories);
  fastify.get<{ Params: { slug: string } }>(
    "/categories/:slug",
    getCategory
  );

  // Editors/Admin only
  fastify.post(
    "/categories",
    { preHandler: [authenticate, requireEditor] },
    createCategory
  );
  fastify.patch<{ Params: { id: string } }>(
    "/categories/:id",
    { preHandler: [authenticate, requireEditor] },
    updateCategory
  );
  fastify.delete<{ Params: { id: string } }>(
    "/categories/:id",
    { preHandler: [authenticate, requireEditor] },
    deleteCategory
  );
}




// // src/modules/categories/index.ts

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

// const CreateCategorySchema = z.object({
//   name:           z.string().min(2).max(60),
//   description:    z.string().max(500).optional(),
//   seoDescription: z.string().max(160).optional(),
//   coverGradient:  z.string().max(120).optional(),
//   emoji:          z.string().max(4).optional(),
//   sortOrder:      z.coerce.number().int().min(0).default(0),
// });

// const UpdateCategorySchema = CreateCategorySchema.partial();

// type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;
// type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const CategoriesService = {
//   async list() {
//     const cached = await cacheGet(CacheKeys.categories());
//     if (cached) return cached;

//     const categories = await prisma.category.findMany({
//       orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
//             },
//           },
//         },
//       },
//     });

//     const result = categories.map((c) => ({
//       ...c,
//       postCount: c._count.posts,
//       _count: undefined,
//     }));

//     await cacheSet(CacheKeys.categories(), result, config.CACHE_TTL_CATEGORIES);
//     return result;
//   },

//   async getBySlug(slug: string) {
//     const cached = await cacheGet(CacheKeys.category(slug));
//     if (cached) return cached;

//     const category = await prisma.category.findUnique({
//       where: { slug },
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
//             },
//           },
//         },
//       },
//     });

//     if (!category) return null;

//     const result = {
//       ...category,
//       postCount: category._count.posts,
//       _count: undefined,
//     };

//     await cacheSet(CacheKeys.category(slug), result, config.CACHE_TTL_CATEGORIES);
//     return result;
//   },

//   async create(input: CreateCategoryInput) {
//     const slug = toSlug(input.name);

//     const existing = await prisma.category.findUnique({ where: { slug } });
//     if (existing) {
//       throw Object.assign(
//         new Error(`Category with slug "${slug}" already exists`),
//         { code: "CONFLICT" }
//       );
//     }

//     const category = await prisma.category.create({
//       data: { ...input, slug },
//     });

//     await cacheDelete(CacheKeys.categories());
//     return category;
//   },

//   async update(id: string, input: UpdateCategoryInput) {
//     const existing = await prisma.category.findUnique({
//       where: { id },
//       select: { slug: true, name: true },
//     });
//     if (!existing) return null;

//     let slug: string | undefined;
//     if (input.name && input.name !== existing.name) {
//       slug = toSlug(input.name);
//       const conflict = await prisma.category.findFirst({
//         where: { slug, id: { not: id } },
//       });
//       if (conflict) {
//         throw Object.assign(
//           new Error(`Category with slug "${slug}" already exists`),
//           { code: "CONFLICT" }
//         );
//       }
//     }

//     const category = await prisma.category.update({
//       where: { id },
//       data: { ...input, ...(slug && { slug }) },
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.categories()),
//       cacheDelete(CacheKeys.category(existing.slug)),
//       slug ? cacheDelete(CacheKeys.category(slug)) : Promise.resolve(),
//     ]);

//     return category;
//   },

//   async delete(id: string) {
//     const category = await prisma.category.findUnique({
//       where: { id },
//       select: { slug: true, _count: { select: { posts: true } } },
//     });
//     if (!category) return null;

//     if (category._count.posts > 0) {
//       throw Object.assign(
//         new Error(
//           `Cannot delete category with ${category._count.posts} posts. Reassign posts first.`
//         ),
//         { code: "CONFLICT" }
//       );
//     }

//     await prisma.category.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.categories()),
//       cacheDelete(CacheKeys.category(category.slug)),
//     ]);
//     return true;
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listCategories(_req: FastifyRequest, reply: FastifyReply) {
//   const data = await CategoriesService.list();
//   return reply.send({ success: true, data });
// }

// async function getCategory(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await CategoriesService.getBySlug(request.params.slug);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Category not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function createCategory(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreateCategorySchema.parse(request.body);
//   const data = await CategoriesService.create(input);
//   return reply.code(201).send({ success: true, data });
// }

// async function updateCategory(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdateCategorySchema.parse(request.body);
//   const data = await CategoriesService.update(request.params.id, input);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Category not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function deleteCategory(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   await CategoriesService.delete(request.params.id);
//   return reply.code(204).send();
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function categoriesRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.get("/categories", listCategories);
//   fastify.get<{ Params: { slug: string } }>(
//     "/categories/:slug",
//     getCategory
//   );

//   // Editors/Admin only
//   fastify.post(
//     "/categories",
//     { preHandler: [authenticate, requireEditor] },
//     createCategory
//   );
//   fastify.patch<{ Params: { id: string } }>(
//     "/categories/:id",
//     { preHandler: [authenticate, requireEditor] },
//     updateCategory
//   );
//   fastify.delete<{ Params: { id: string } }>(
//     "/categories/:id",
//     { preHandler: [authenticate, requireEditor] },
//     deleteCategory
//   );
// }



// // src/modules/categories/index.ts

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

// const CreateCategorySchema = z.object({
//   name:           z.string().min(2).max(60),
//   description:    z.string().max(500).optional(),
//   seoDescription: z.string().max(160).optional(),
//   coverGradient:  z.string().max(120).optional(),
//   emoji:          z.string().max(4).optional(),
//   sortOrder:      z.coerce.number().int().min(0).default(0),
// });

// const UpdateCategorySchema = CreateCategorySchema.partial();

// type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;
// type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const CategoriesService = {
//   async list() {
//     const cached = await cacheGet(CacheKeys.categories());
//     if (cached) return cached;

//     const categories = await prisma.category.findMany({
//       orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
//             },
//           },
//         },
//       },
//     });

//     const result = categories.map((c) => ({
//       ...c,
//       postCount: c._count.posts,
//       _count: undefined,
//     }));

//     await cacheSet(CacheKeys.categories(), result, config.CACHE_TTL_CATEGORIES);
//     return result;
//   },

//   async getBySlug(slug: string) {
//     const cached = await cacheGet(CacheKeys.category(slug));
//     if (cached) return cached;

//     const category = await prisma.category.findUnique({
//       where: { slug },
//       include: {
//         _count: {
//           select: {
//             posts: {
//               where: { status: "PUBLISHED", publishedAt: { lte: new Date() } },
//             },
//           },
//         },
//       },
//     });

//     if (!category) return null;

//     const result = {
//       ...category,
//       postCount: category._count.posts,
//       _count: undefined,
//     };

//     await cacheSet(CacheKeys.category(slug), result, config.CACHE_TTL_CATEGORIES);
//     return result;
//   },

//   async create(input: CreateCategoryInput) {
//     const slug = toSlug(input.name);

//     const existing = await prisma.category.findUnique({ where: { slug } });
//     if (existing) {
//       throw Object.assign(
//         new Error(`Category with slug "${slug}" already exists`),
//         { code: "CONFLICT" }
//       );
//     }

//     const category = await prisma.category.create({
//       data: { ...input, slug },
//     });

//     await cacheDelete(CacheKeys.categories());
//     return category;
//   },

//   async update(id: string, input: UpdateCategoryInput) {
//     const existing = await prisma.category.findUnique({
//       where: { id },
//       select: { slug: true, name: true },
//     });
//     if (!existing) return null;

//     let slug: string | undefined;
//     if (input.name && input.name !== existing.name) {
//       slug = toSlug(input.name);
//       const conflict = await prisma.category.findFirst({
//         where: { slug, id: { not: id } },
//       });
//       if (conflict) {
//         throw Object.assign(
//           new Error(`Category with slug "${slug}" already exists`),
//           { code: "CONFLICT" }
//         );
//       }
//     }

//     const category = await prisma.category.update({
//       where: { id },
//       data: { ...input, ...(slug && { slug }) },
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.categories()),
//       cacheDelete(CacheKeys.category(existing.slug)),
//       slug ? cacheDelete(CacheKeys.category(slug)) : Promise.resolve(),
//     ]);

//     return category;
//   },

//   async delete(id: string) {
//     const category = await prisma.category.findUnique({
//       where: { id },
//       select: { slug: true, _count: { select: { posts: true } } },
//     });
//     if (!category) return null;

//     if (category._count.posts > 0) {
//       throw Object.assign(
//         new Error(
//           `Cannot delete category with ${category._count.posts} posts. Reassign posts first.`
//         ),
//         { code: "CONFLICT" }
//       );
//     }

//     await prisma.category.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.categories()),
//       cacheDelete(CacheKeys.category(category.slug)),
//     ]);
//     return true;
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listCategories(_req: FastifyRequest, reply: FastifyReply) {
//   const data = await CategoriesService.list();
//   return reply.send({ success: true, data });
// }

// async function getCategory(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const data = await CategoriesService.getBySlug(request.params.slug);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Category not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function createCategory(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreateCategorySchema.parse(request.body);
//   const data = await CategoriesService.create(input);
//   return reply.code(201).send({ success: true, data });
// }

// async function updateCategory(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdateCategorySchema.parse(request.body);
//   const data = await CategoriesService.update(request.params.id, input);
//   if (!data) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Category not found" },
//     });
//   }
//   return reply.send({ success: true, data });
// }

// async function deleteCategory(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   await CategoriesService.delete(request.params.id);
//   return reply.code(204).send();
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function categoriesRoutes(fastify: FastifyInstance) {
//   // Public
//   fastify.get("/categories", listCategories);
//   fastify.get<{ Params: { slug: string } }>(
//     "/categories/:slug",
//     getCategory
//   );

//   // Editors/Admin only
//   fastify.post(
//     "/categories",
//     { preHandler: [authenticate, requireEditor] },
//     createCategory
//   );
//   fastify.patch<{ Params: { id: string } }>(
//     "/categories/:id",
//     { preHandler: [authenticate, requireEditor] },
//     updateCategory
//   );
//   fastify.delete<{ Params: { id: string } }>(
//     "/categories/:id",
//     { preHandler: [authenticate, requireEditor] },
//     deleteCategory
//   );
// }