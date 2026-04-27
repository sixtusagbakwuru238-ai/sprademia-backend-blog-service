// src/modules/posts/__tests__/posts.service.test.ts
// Unit tests for the PostsService business logic layer.
// Database calls are mocked — no real DB needed to run these.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
vi.mock("../../../lib/prisma", () => ({
  prisma: {
    post: {
      findMany:  vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create:    vi.fn(),
      update:    vi.fn(),
      delete:    vi.fn(),
      count:     vi.fn(),
    },
    postTag: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    postRevision: { create: vi.fn() },
    postReaction: {
      findUnique: vi.fn(),
      create:     vi.fn(),
      delete:     vi.fn(),
    },
    postView: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown) => Promise.all(Array.isArray(ops) ? ops : [ops])),
  },
}));

// Mock Redis
vi.mock("../../../lib/redis", () => ({
  cacheGet:           vi.fn().mockResolvedValue(null),
  cacheSet:           vi.fn().mockResolvedValue(undefined),
  cacheDelete:        vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
  incrementPostViewBuffer: vi.fn().mockResolvedValue(undefined),
  CacheKeys: {
    post:   (slug: string) => `blog:post:${slug}`,
    posts:  (p: string)    => `blog:posts:${p}`,
  },
}));

// Mock message bus
vi.mock("../../../lib/message-bus", () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

// Mock content utilities
vi.mock("../../../lib/content", () => ({
  uniquePostSlug: vi.fn().mockResolvedValue("test-post"),
  renderMarkdown: vi.fn().mockResolvedValue("<p>content</p>"),
  calculateReadTime: vi.fn().mockReturnValue(5),
  generateExcerpt:   vi.fn().mockReturnValue("Test excerpt…"),
}));

// Mock config
vi.mock("../../../config", () => ({
  config: { CACHE_TTL_POSTS: 300, CACHE_TTL_POST: 600 },
}));

import { PostsService } from "../index";
import { prisma } from "../../../lib/prisma";
import { publish } from "../../../lib/message-bus";
import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Test data factories
// ─────────────────────────────────────────────────────────────────────

const mockAuthor = {
  id: "author-1",
  displayName: "Chukwuemeka Obi",
  avatarUrl: null,
  role: "creator",
  school: "UNILAG",
  verified: true,
};

const mockCategory = {
  id: "cat-1",
  slug: "exam-prep",
  name: "Exam Prep",
  emoji: "📚",
  coverGradient: "from-blue-600 to-indigo-700",
};

const mockPost = {
  id: "post-1",
  slug: "how-to-score-300-jamb",
  title: "How to Score 300+ in JAMB",
  excerpt: "Test excerpt",
  coverEmoji: "📚",
  coverImageUrl: null,
  coverGradient: "from-blue-600 to-indigo-700",
  featured: true,
  status: "PUBLISHED" as const,
  readTimeMinutes: 12,
  seoTitle: null,
  seoDescription: null,
  publishedAt: new Date("2024-12-18"),
  viewCount: 1000,
  likeCount: 500,
  commentCount: 20,
  shareCount: 50,
  bookmarkCount: 100,
  author: mockAuthor,
  category: mockCategory,
  tags: [{ tag: { id: "tag-1", slug: "jamb", name: "JAMB" } }],
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("PostsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── list ──────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns paginated published posts for public viewers", async () => {
      vi.mocked(prisma.post.count).mockResolvedValue(1);
      vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

      const result = await PostsService.list(
        { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
        undefined // no viewer = public
      );

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasNext).toBe(false);

      // Should filter to PUBLISHED only for public
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PUBLISHED" }),
        })
      );
    });

    it("correctly calculates pagination values", async () => {
      vi.mocked(prisma.post.count).mockResolvedValue(30);
      vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

      const result = await PostsService.list(
        { page: 2, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
        undefined
      );

      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.hasNext).toBe(true);
      expect(result.pagination.hasPrev).toBe(true);
    });

    it("normalises tags from PostTag join to flat array", async () => {
      vi.mocked(prisma.post.count).mockResolvedValue(1);
      vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

      const result = await PostsService.list(
        { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
        undefined
      );

      const firstPost = result.data[0] as { tags: Array<{ slug: string }> };
      expect(firstPost.tags[0]).toEqual({ id: "tag-1", slug: "jamb", name: "JAMB" });
    });
  });

  // ── getBySlug ─────────────────────────────────────────────────────

  describe("getBySlug()", () => {
    it("returns null for non-existent slug", async () => {
      vi.mocked(prisma.post.findFirst).mockResolvedValue(null);

      const result = await PostsService.getBySlug("non-existent-post");
      expect(result).toBeNull();
    });

    it("fetches from DB when cache is empty", async () => {
      const { cacheGet } = await import("../../../lib/redis");
      vi.mocked(cacheGet).mockResolvedValue(null);
      vi.mocked(prisma.post.findFirst).mockResolvedValue({
        ...mockPost,
        contentHtml: "<p>content</p>",
      } as never);

      const result = await PostsService.getBySlug("how-to-score-300-jamb");
      expect(result).not.toBeNull();
      expect(prisma.post.findFirst).toHaveBeenCalledOnce();
    });

    it("returns cached value without hitting DB", async () => {
      const { cacheGet } = await import("../../../lib/redis");
      vi.mocked(cacheGet).mockResolvedValue(mockPost);

      const result = await PostsService.getBySlug("how-to-score-300-jamb");
      expect(result).toEqual(mockPost);
      expect(prisma.post.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── create ────────────────────────────────────────────────────────

  describe("create()", () => {
    it("creates a post with generated slug and rendered HTML", async () => {
      vi.mocked(prisma.post.create).mockResolvedValue({
        ...mockPost,
        status: "DRAFT",
        publishedAt: null,
      } as never);

      await PostsService.create(
        {
          title: "How to Score 300+ in JAMB",
          content: "## Section\n\nParagraph content here for testing.",
          categoryId: "cat-1",
          tags: [],
          featured: false,
          status: "DRAFT",
        },
        "author-1"
      );

      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: "test-post",
            authorId: "author-1",
            contentHtml: "<p>content</p>",
          }),
        })
      );
    });

    it("publishes blog.post.published event when status is PUBLISHED", async () => {
      vi.mocked(prisma.post.create).mockResolvedValue({
        ...mockPost,
        status: "PUBLISHED",
      } as never);

      await PostsService.create(
        {
          title: "Test Post",
          content: "Long enough content for testing purposes here.",
          categoryId: "cat-1",
          tags: [],
          featured: false,
          status: "PUBLISHED",
        },
        "author-1"
      );

      expect(publish).toHaveBeenCalledWith(
        "blog.post.published",
        expect.objectContaining({ authorId: "author-1" })
      );
    });

    it("does NOT publish event when status is DRAFT", async () => {
      vi.mocked(prisma.post.create).mockResolvedValue({
        ...mockPost,
        status: "DRAFT",
        publishedAt: null,
      } as never);

      await PostsService.create(
        {
          title: "Draft Post",
          content: "Long enough content for testing purposes.",
          categoryId: "cat-1",
          tags: [],
          featured: false,
          status: "DRAFT",
        },
        "author-1"
      );

      expect(publish).not.toHaveBeenCalled();
    });
  });

  // ── toggleReaction ────────────────────────────────────────────────

  describe("toggleReaction()", () => {
    it("creates a reaction when none exists", async () => {
      vi.mocked(prisma.postReaction.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

      const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

      expect(result.active).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it("removes a reaction when one already exists", async () => {
      vi.mocked(prisma.postReaction.findUnique).mockResolvedValue({
        postId: "post-1",
        userId: "user-1",
        type: "LIKE",
        createdAt: new Date(),
      } as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

      const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

      expect(result.active).toBe(false);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("returns false when post not found", async () => {
      vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

      const result = await PostsService.delete("non-existent-id");
      expect(result).toBe(false);
    });

    it("deletes post and publishes event on success", async () => {
      vi.mocked(prisma.post.findUnique).mockResolvedValue({
        slug: "test-post",
      } as never);
      vi.mocked(prisma.post.delete).mockResolvedValue({} as never);

      const result = await PostsService.delete("post-1");

      expect(result).toBe(true);
      expect(publish).toHaveBeenCalledWith(
        "blog.post.deleted",
        expect.objectContaining({ postId: "post-1", slug: "test-post" })
      );
    });
  });
});




// // src/modules/posts/__tests__/posts.service.test.ts
// // Unit tests for the PostsService business logic layer.
// // Database calls are mocked — no real DB needed to run these.

// import { describe, it, expect, vi, beforeEach } from "vitest";

// // Mock Prisma
// vi.mock("../../../lib/prisma", () => ({
//   prisma: {
//     post: {
//       findMany:  vi.fn(),
//       findFirst: vi.fn(),
//       findUnique: vi.fn(),
//       create:    vi.fn(),
//       update:    vi.fn(),
//       delete:    vi.fn(),
//       count:     vi.fn(),
//     },
//     postTag: {
//       deleteMany: vi.fn(),
//       createMany: vi.fn(),
//     },
//     postRevision: { create: vi.fn() },
//     postReaction: {
//       findUnique: vi.fn(),
//       create:     vi.fn(),
//       delete:     vi.fn(),
//     },
//     postView: { create: vi.fn() },
//     $transaction: vi.fn((ops: unknown) => Promise.all(Array.isArray(ops) ? ops : [ops])),
//   },
// }));

// // Mock Redis
// vi.mock("../../../lib/redis", () => ({
//   cacheGet:           vi.fn().mockResolvedValue(null),
//   cacheSet:           vi.fn().mockResolvedValue(undefined),
//   cacheDelete:        vi.fn().mockResolvedValue(undefined),
//   cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
//   incrementPostViewBuffer: vi.fn().mockResolvedValue(undefined),
//   CacheKeys: {
//     post:   (slug: string) => `blog:post:${slug}`,
//     posts:  (p: string)    => `blog:posts:${p}`,
//   },
// }));

// // Mock message bus
// vi.mock("../../../lib/message-bus", () => ({
//   publish: vi.fn().mockResolvedValue(undefined),
// }));

// // Mock content utilities
// vi.mock("../../../lib/content", () => ({
//   uniquePostSlug: vi.fn().mockResolvedValue("test-post"),
//   renderMarkdown: vi.fn().mockResolvedValue("<p>content</p>"),
//   calculateReadTime: vi.fn().mockReturnValue(5),
//   generateExcerpt:   vi.fn().mockReturnValue("Test excerpt…"),
// }));

// // Mock config
// vi.mock("../../../config", () => ({
//   config: { CACHE_TTL_POSTS: 300, CACHE_TTL_POST: 600 },
// }));

// import { PostsService } from "../index";
// import { prisma } from "../../../lib/prisma";
// import { publish } from "../../../lib/message-bus";
// import crypto from "crypto";

// // ─────────────────────────────────────────────────────────────────────
// // Test data factories
// // ─────────────────────────────────────────────────────────────────────

// const mockAuthor = {
//   id: "author-1",
//   displayName: "Chukwuemeka Obi",
//   avatarUrl: null,
//   role: "creator",
//   school: "UNILAG",
//   verified: true,
// };

// const mockCategory = {
//   id: "cat-1",
//   slug: "exam-prep",
//   name: "Exam Prep",
//   emoji: "📚",
//   coverGradient: "from-blue-600 to-indigo-700",
// };

// const mockPost = {
//   id: "post-1",
//   slug: "how-to-score-300-jamb",
//   title: "How to Score 300+ in JAMB",
//   excerpt: "Test excerpt",
//   coverEmoji: "📚",
//   coverImageUrl: null,
//   coverGradient: "from-blue-600 to-indigo-700",
//   featured: true,
//   status: "PUBLISHED" as const,
//   readTimeMinutes: 12,
//   seoTitle: null,
//   seoDescription: null,
//   publishedAt: new Date("2024-12-18"),
//   viewCount: 1000,
//   likeCount: 500,
//   commentCount: 20,
//   shareCount: 50,
//   bookmarkCount: 100,
//   author: mockAuthor,
//   category: mockCategory,
//   tags: [{ tag: { id: "tag-1", slug: "jamb", name: "JAMB" } }],
//   createdAt: new Date(),
//   updatedAt: new Date(),
// };

// // ─────────────────────────────────────────────────────────────────────
// // Tests
// // ─────────────────────────────────────────────────────────────────────

// describe("PostsService", () => {
//   beforeEach(() => {
//     vi.clearAllMocks();
//   });

//   // ── list ──────────────────────────────────────────────────────────

//   describe("list()", () => {
//     it("returns paginated published posts for public viewers", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(1);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined // no viewer = public
//       );

//       expect(result.data).toHaveLength(1);
//       expect(result.pagination.total).toBe(1);
//       expect(result.pagination.hasNext).toBe(false);

//       // Should filter to PUBLISHED only for public
//       expect(prisma.post.findMany).toHaveBeenCalledWith(
//         expect.objectContaining({
//           where: expect.objectContaining({ status: "PUBLISHED" }),
//         })
//       );
//     });

//     it("correctly calculates pagination values", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(30);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 2, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined
//       );

//       expect(result.pagination.totalPages).toBe(3);
//       expect(result.pagination.hasNext).toBe(true);
//       expect(result.pagination.hasPrev).toBe(true);
//     });

//     it("normalises tags from PostTag join to flat array", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(1);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined
//       );

//       const firstPost = result.data[0] as { tags: Array<{ slug: string }> };
//       expect(firstPost.tags[0]).toEqual({ id: "tag-1", slug: "jamb", name: "JAMB" });
//     });
//   });

//   // ── getBySlug ─────────────────────────────────────────────────────

//   describe("getBySlug()", () => {
//     it("returns null for non-existent slug", async () => {
//       vi.mocked(prisma.post.findFirst).mockResolvedValue(null);

//       const result = await PostsService.getBySlug("non-existent-post");
//       expect(result).toBeNull();
//     });

//     it("fetches from DB when cache is empty", async () => {
//       const { cacheGet } = await import("../../../lib/redis");
//       vi.mocked(cacheGet).mockResolvedValue(null);
//       vi.mocked(prisma.post.findFirst).mockResolvedValue({
//         ...mockPost,
//         contentHtml: "<p>content</p>",
//       } as never);

//       const result = await PostsService.getBySlug("how-to-score-300-jamb");
//       expect(result).not.toBeNull();
//       expect(prisma.post.findFirst).toHaveBeenCalledOnce();
//     });

//     it("returns cached value without hitting DB", async () => {
//       const { cacheGet } = await import("../../../lib/redis");
//       vi.mocked(cacheGet).mockResolvedValue(mockPost);

//       const result = await PostsService.getBySlug("how-to-score-300-jamb");
//       expect(result).toEqual(mockPost);
//       expect(prisma.post.findFirst).not.toHaveBeenCalled();
//     });
//   });

//   // ── create ────────────────────────────────────────────────────────

//   describe("create()", () => {
//     it("creates a post with generated slug and rendered HTML", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "DRAFT",
//         publishedAt: null,
//       } as never);

//       await PostsService.create(
//         {
//           title: "How to Score 300+ in JAMB",
//           content: "## Section\n\nParagraph content here for testing.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "DRAFT",
//         },
//         "author-1"
//       );

//       expect(prisma.post.create).toHaveBeenCalledWith(
//         expect.objectContaining({
//           data: expect.objectContaining({
//             slug: "test-post",
//             authorId: "author-1",
//             contentHtml: "<p>content</p>",
//           }),
//         })
//       );
//     });

//     it("publishes blog.post.published event when status is PUBLISHED", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "PUBLISHED",
//       } as never);

//       await PostsService.create(
//         {
//           title: "Test Post",
//           content: "Long enough content for testing purposes here.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "PUBLISHED",
//         },
//         "author-1"
//       );

//       expect(publish).toHaveBeenCalledWith(
//         "blog.post.published",
//         expect.objectContaining({ authorId: "author-1" })
//       );
//     });

//     it("does NOT publish event when status is DRAFT", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "DRAFT",
//         publishedAt: null,
//       } as never);

//       await PostsService.create(
//         {
//           title: "Draft Post",
//           content: "Long enough content for testing purposes.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "DRAFT",
//         },
//         "author-1"
//       );

//       expect(publish).not.toHaveBeenCalled();
//     });
//   });

//   // ── toggleReaction ────────────────────────────────────────────────

//   describe("toggleReaction()", () => {
//     it("creates a reaction when none exists", async () => {
//       vi.mocked(prisma.postReaction.findUnique).mockResolvedValue(null);
//       vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

//       const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

//       expect(result.active).toBe(true);
//       expect(prisma.$transaction).toHaveBeenCalled();
//     });

//     it("removes a reaction when one already exists", async () => {
//       vi.mocked(prisma.postReaction.findUnique).mockResolvedValue({
//         postId: "post-1",
//         userId: "user-1",
//         type: "LIKE",
//         createdAt: new Date(),
//       } as never);
//       vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

//       const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

//       expect(result.active).toBe(false);
//     });
//   });

//   // ── delete ────────────────────────────────────────────────────────

//   describe("delete()", () => {
//     it("returns false when post not found", async () => {
//       vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

//       const result = await PostsService.delete("non-existent-id");
//       expect(result).toBe(false);
//     });

//     it("deletes post and publishes event on success", async () => {
//       vi.mocked(prisma.post.findUnique).mockResolvedValue({
//         slug: "test-post",
//       } as never);
//       vi.mocked(prisma.post.delete).mockResolvedValue({} as never);

//       const result = await PostsService.delete("post-1");

//       expect(result).toBe(true);
//       expect(publish).toHaveBeenCalledWith(
//         "blog.post.deleted",
//         expect.objectContaining({ postId: "post-1", slug: "test-post" })
//       );
//     });
//   });
// });



// // src/modules/posts/__tests__/posts.service.test.ts
// // Unit tests for the PostsService business logic layer.
// // Database calls are mocked — no real DB needed to run these.

// import { describe, it, expect, vi, beforeEach } from "vitest";

// // Mock Prisma
// vi.mock("../../../lib/prisma", () => ({
//   prisma: {
//     post: {
//       findMany:  vi.fn(),
//       findFirst: vi.fn(),
//       findUnique: vi.fn(),
//       create:    vi.fn(),
//       update:    vi.fn(),
//       delete:    vi.fn(),
//       count:     vi.fn(),
//     },
//     postTag: {
//       deleteMany: vi.fn(),
//       createMany: vi.fn(),
//     },
//     postRevision: { create: vi.fn() },
//     postReaction: {
//       findUnique: vi.fn(),
//       create:     vi.fn(),
//       delete:     vi.fn(),
//     },
//     postView: { create: vi.fn() },
//     $transaction: vi.fn((ops: unknown) => Promise.all(Array.isArray(ops) ? ops : [ops])),
//   },
// }));

// // Mock Redis
// vi.mock("../../../lib/redis", () => ({
//   cacheGet:           vi.fn().mockResolvedValue(null),
//   cacheSet:           vi.fn().mockResolvedValue(undefined),
//   cacheDelete:        vi.fn().mockResolvedValue(undefined),
//   cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
//   incrementPostViewBuffer: vi.fn().mockResolvedValue(undefined),
//   CacheKeys: {
//     post:   (slug: string) => `blog:post:${slug}`,
//     posts:  (p: string)    => `blog:posts:${p}`,
//   },
// }));

// // Mock message bus
// vi.mock("../../../lib/message-bus", () => ({
//   publish: vi.fn().mockResolvedValue(undefined),
// }));

// // Mock content utilities
// vi.mock("../../../lib/content", () => ({
//   uniquePostSlug: vi.fn().mockResolvedValue("test-post"),
//   renderMarkdown: vi.fn().mockResolvedValue("<p>content</p>"),
//   calculateReadTime: vi.fn().mockReturnValue(5),
//   generateExcerpt:   vi.fn().mockReturnValue("Test excerpt…"),
// }));

// // Mock config
// vi.mock("../../../config", () => ({
//   config: { CACHE_TTL_POSTS: 300, CACHE_TTL_POST: 600 },
// }));

// import { PostsService } from "../index";
// import { prisma } from "../../../lib/prisma";
// import { publish } from "../../../lib/message-bus";
// import crypto from "crypto";

// // ─────────────────────────────────────────────────────────────────────
// // Test data factories
// // ─────────────────────────────────────────────────────────────────────

// const mockAuthor = {
//   id: "author-1",
//   displayName: "Chukwuemeka Obi",
//   avatarUrl: null,
//   role: "creator",
//   school: "UNILAG",
//   verified: true,
// };

// const mockCategory = {
//   id: "cat-1",
//   slug: "exam-prep",
//   name: "Exam Prep",
//   emoji: "📚",
//   coverGradient: "from-blue-600 to-indigo-700",
// };

// const mockPost = {
//   id: "post-1",
//   slug: "how-to-score-300-jamb",
//   title: "How to Score 300+ in JAMB",
//   excerpt: "Test excerpt",
//   coverEmoji: "📚",
//   coverImageUrl: null,
//   coverGradient: "from-blue-600 to-indigo-700",
//   featured: true,
//   status: "PUBLISHED" as const,
//   readTimeMinutes: 12,
//   seoTitle: null,
//   seoDescription: null,
//   publishedAt: new Date("2024-12-18"),
//   viewCount: 1000,
//   likeCount: 500,
//   commentCount: 20,
//   shareCount: 50,
//   bookmarkCount: 100,
//   author: mockAuthor,
//   category: mockCategory,
//   tags: [{ tag: { id: "tag-1", slug: "jamb", name: "JAMB" } }],
//   createdAt: new Date(),
//   updatedAt: new Date(),
// };

// // ─────────────────────────────────────────────────────────────────────
// // Tests
// // ─────────────────────────────────────────────────────────────────────

// describe("PostsService", () => {
//   beforeEach(() => {
//     vi.clearAllMocks();
//   });

//   // ── list ──────────────────────────────────────────────────────────

//   describe("list()", () => {
//     it("returns paginated published posts for public viewers", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(1);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined // no viewer = public
//       );

//       expect(result.data).toHaveLength(1);
//       expect(result.pagination.total).toBe(1);
//       expect(result.pagination.hasNext).toBe(false);

//       // Should filter to PUBLISHED only for public
//       expect(prisma.post.findMany).toHaveBeenCalledWith(
//         expect.objectContaining({
//           where: expect.objectContaining({ status: "PUBLISHED" }),
//         })
//       );
//     });

//     it("correctly calculates pagination values", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(30);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 2, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined
//       );

//       expect(result.pagination.totalPages).toBe(3);
//       expect(result.pagination.hasNext).toBe(true);
//       expect(result.pagination.hasPrev).toBe(true);
//     });

//     it("normalises tags from PostTag join to flat array", async () => {
//       vi.mocked(prisma.post.count).mockResolvedValue(1);
//       vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

//       const result = await PostsService.list(
//         { page: 1, limit: 12, sortBy: "publishedAt", sortOrder: "desc" },
//         undefined
//       );

//       const firstPost = result.data[0] as { tags: Array<{ slug: string }> };
//       expect(firstPost.tags[0]).toEqual({ id: "tag-1", slug: "jamb", name: "JAMB" });
//     });
//   });

//   // ── getBySlug ─────────────────────────────────────────────────────

//   describe("getBySlug()", () => {
//     it("returns null for non-existent slug", async () => {
//       vi.mocked(prisma.post.findFirst).mockResolvedValue(null);

//       const result = await PostsService.getBySlug("non-existent-post");
//       expect(result).toBeNull();
//     });

//     it("fetches from DB when cache is empty", async () => {
//       const { cacheGet } = await import("../../../lib/redis");
//       vi.mocked(cacheGet).mockResolvedValue(null);
//       vi.mocked(prisma.post.findFirst).mockResolvedValue({
//         ...mockPost,
//         contentHtml: "<p>content</p>",
//       } as never);

//       const result = await PostsService.getBySlug("how-to-score-300-jamb");
//       expect(result).not.toBeNull();
//       expect(prisma.post.findFirst).toHaveBeenCalledOnce();
//     });

//     it("returns cached value without hitting DB", async () => {
//       const { cacheGet } = await import("../../../lib/redis");
//       vi.mocked(cacheGet).mockResolvedValue(mockPost);

//       const result = await PostsService.getBySlug("how-to-score-300-jamb");
//       expect(result).toEqual(mockPost);
//       expect(prisma.post.findFirst).not.toHaveBeenCalled();
//     });
//   });

//   // ── create ────────────────────────────────────────────────────────

//   describe("create()", () => {
//     it("creates a post with generated slug and rendered HTML", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "DRAFT",
//         publishedAt: null,
//       } as never);

//       await PostsService.create(
//         {
//           title: "How to Score 300+ in JAMB",
//           content: "## Section\n\nParagraph content here for testing.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "DRAFT",
//         },
//         "author-1"
//       );

//       expect(prisma.post.create).toHaveBeenCalledWith(
//         expect.objectContaining({
//           data: expect.objectContaining({
//             slug: "test-post",
//             authorId: "author-1",
//             contentHtml: "<p>content</p>",
//           }),
//         })
//       );
//     });

//     it("publishes blog.post.published event when status is PUBLISHED", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "PUBLISHED",
//       } as never);

//       await PostsService.create(
//         {
//           title: "Test Post",
//           content: "Long enough content for testing purposes here.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "PUBLISHED",
//         },
//         "author-1"
//       );

//       expect(publish).toHaveBeenCalledWith(
//         "blog.post.published",
//         expect.objectContaining({ authorId: "author-1" })
//       );
//     });

//     it("does NOT publish event when status is DRAFT", async () => {
//       vi.mocked(prisma.post.create).mockResolvedValue({
//         ...mockPost,
//         status: "DRAFT",
//         publishedAt: null,
//       } as never);

//       await PostsService.create(
//         {
//           title: "Draft Post",
//           content: "Long enough content for testing purposes.",
//           categoryId: "cat-1",
//           tags: [],
//           featured: false,
//           status: "DRAFT",
//         },
//         "author-1"
//       );

//       expect(publish).not.toHaveBeenCalled();
//     });
//   });

//   // ── toggleReaction ────────────────────────────────────────────────

//   describe("toggleReaction()", () => {
//     it("creates a reaction when none exists", async () => {
//       vi.mocked(prisma.postReaction.findUnique).mockResolvedValue(null);
//       vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

//       const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

//       expect(result.active).toBe(true);
//       expect(prisma.$transaction).toHaveBeenCalled();
//     });

//     it("removes a reaction when one already exists", async () => {
//       vi.mocked(prisma.postReaction.findUnique).mockResolvedValue({
//         postId: "post-1",
//         userId: "user-1",
//         type: "LIKE",
//         createdAt: new Date(),
//       } as never);
//       vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

//       const result = await PostsService.toggleReaction("post-1", "user-1", "LIKE");

//       expect(result.active).toBe(false);
//     });
//   });

//   // ── delete ────────────────────────────────────────────────────────

//   describe("delete()", () => {
//     it("returns false when post not found", async () => {
//       vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

//       const result = await PostsService.delete("non-existent-id");
//       expect(result).toBe(false);
//     });

//     it("deletes post and publishes event on success", async () => {
//       vi.mocked(prisma.post.findUnique).mockResolvedValue({
//         slug: "test-post",
//       } as never);
//       vi.mocked(prisma.post.delete).mockResolvedValue({} as never);

//       const result = await PostsService.delete("post-1");

//       expect(result).toBe(true);
//       expect(publish).toHaveBeenCalledWith(
//         "blog.post.deleted",
//         expect.objectContaining({ postId: "post-1", slug: "test-post" })
//       );
//     });
//   });
// });