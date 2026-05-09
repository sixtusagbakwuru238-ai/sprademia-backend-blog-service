// src/modules/posts/index.ts
// Posts module — updated getBySlug to return the rich content format
// matching the documented API shape with all 12 content section types.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { PostStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { publish } from "../../lib/message-bus";
import {
  cacheGet, cacheSet, cacheDelete, cacheDeletePattern, incrementPostViewBuffer,
  CacheKeys,
} from "../../lib/redis";
import {
  uniquePostSlug, calculateReadTime, generateExcerpt,
} from "../../lib/content";
import { authenticate, optionalAuthenticate, requireEditor } from "../../middleware/auth";
import { config } from "../../config";
import type { AuthenticatedUser, PostPublishedPayload } from "../../types";
import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────
// Content section schema (Zod)
// Validates the JSON stored in the `content` DB column.
// ─────────────────────────────────────────────────────────────────────

const ParagraphSectionSchema = z.object({
  type: z.literal("paragraph"),
  content: z.string(),
});

const ParagraphWithLinksSectionSchema = z.object({
  type: z.literal("paragraphWithLinks"),
  contentHtml: z.string(),
});

const HeadingSectionSchema = z.object({
  type: z.literal("heading"),
  content: z.string(),
});

const SubheadingSectionSchema = z.object({
  type: z.literal("subheading"),
  content: z.string(),
});

const QuoteSectionSchema = z.object({
  type: z.literal("quote"),
  content: z.string(),
});

const TipSectionSchema = z.object({
  type: z.literal("tip"),
  content: z.string(),
});

const ListSectionSchema = z.object({
  type: z.literal("list"),
  items: z.array(z.string()),
});

const NumberedListSectionSchema = z.object({
  type: z.literal("numberedList"),
  items: z.array(z.string()),
});

const TwoColumnListSectionSchema = z.object({
  type: z.literal("twoColumnList"),
  leftColumnTitle: z.string(),
  leftColumnItems: z.array(z.string()),
  rightColumnTitle: z.string(),
  rightColumnItems: z.array(z.string()),
});

const ImageSectionSchema = z.object({
  type: z.literal("image"),
  imageUrl: z.string(),
  altText: z.string(),
  caption: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const ImageWithLinksSchema = z.object({
  type: z.literal("imageWithLinks"),
  imageUrl: z.string(),
  altText: z.string(),
  caption: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  url: z.string().url(),
  openInNewTab: z.boolean().optional().default(false),
  ariaLabel: z.string().optional(),
});



const VideoSectionSchema = z.object({
  type: z.literal("video"),
  videoType: z.enum(["youtube", "native"]),
  videoId: z.string().optional(),
  videoUrl: z.string().optional(),
  videoTitle: z.string(),
  caption: z.string().optional(),
  thumbnailUrl: z.string().optional(),
});

const TableSectionSchema = z.object({
  type: z.literal("table"),
  tableHeaders: z.array(z.string()),
  tableRows: z.array(z.array(z.string())),
  tableCaption: z.string().optional(),
});

const CodeSectionSchema = z.object({
  type: z.literal("code"),
  code: z.string(),
  codeLanguage: z.string().optional(),
});

const CtaSectionSchema = z.object({
  type: z.literal("cta"),
  ctaTitle: z.string(),
  ctaDescription: z.string(),
  ctaButtonText: z.string(),
  ctaLink: z.string(),
  ctaNewTab: z.boolean().optional(),
});

const DividerSectionSchema = z.object({
  type: z.literal("divider"),
});

const ListWithLinksSectionSchema = z.object({
  type: z.literal("listWithLinks"),
  items: z.array(z.string()),   // each item is pre-rendered sanitised HTML
});

const NumberedListWithLinksSectionSchema = z.object({
  type: z.literal("numberedListWithLinks"),
  items: z.array(z.string()),   // each item is pre-rendered sanitised HTML
});

const BlogContentSectionSchema = z.discriminatedUnion("type", [
  ParagraphSectionSchema,
  ParagraphWithLinksSectionSchema,
  HeadingSectionSchema,
  SubheadingSectionSchema,
  QuoteSectionSchema,
  TipSectionSchema,
  ListSectionSchema,
  ListWithLinksSectionSchema,
  NumberedListSectionSchema,
  NumberedListWithLinksSectionSchema,
  TwoColumnListSectionSchema,
  ImageSectionSchema,
  ImageWithLinksSchema,
  VideoSectionSchema,
  TableSectionSchema,
  CodeSectionSchema,
  CtaSectionSchema,
  DividerSectionSchema,
]);

const ContentArraySchema = z.array(BlogContentSectionSchema);

// ─────────────────────────────────────────────────────────────────────
// Request schemas
// ─────────────────────────────────────────────────────────────────────

const CreatePostSchema = z.object({
  title: z.string().min(5).max(200),
  excerpt: z.string().max(500).optional(),
  content: z.array(BlogContentSectionSchema).min(1),  // rich content array
  categoryId: z.string().cuid("Invalid category ID"),
  tags: z.array(z.string().cuid()).max(10).default([]),
  coverEmoji: z.string().max(4).optional(),
  coverGradient: z.string().max(100).optional(),
  featured: z.boolean().default(false),
  status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED"]).default("DRAFT"),
  scheduledAt: z.string().datetime().optional(),
  seoTitle: z.string().max(70).optional(),
  seoDescription: z.string().max(160).optional(),
  readTime: z.string().optional(),      // e.g. "6 min read" — auto-calculated if omitted
  views: z.string().optional(),         // e.g. "0" — starts at 0
});

const UpdatePostSchema = CreatePostSchema.partial();

const ListPostsQuerySchema = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(200).default(12), // 200 allows blogPosts(100) & getAllTags()
  category:  z.string().optional(),
  tag:       z.string().optional(),
  author:    z.string().optional(),
  status:    z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
  featured:  z.coerce.boolean().optional(),
  search:    z.string().max(200).optional(),
  sortBy:    z.enum(["publishedAt", "likeCount", "viewCount", "createdAt"]).default("publishedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

type CreatePostInput = z.infer<typeof CreatePostSchema>;
type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
type ListPostsQuery  = z.infer<typeof ListPostsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Category colour map — injected into responses so frontend is data-driven
// ─────────────────────────────────────────────────────────────────────

const CATEGORY_COLOURS: Record<string, { color: string; bg: string }> = {
  "exam-prep":          { color: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
  "earn-grow":          { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
  "scholarships":       { color: "text-rose-700 dark:text-rose-400",    bg: "bg-rose-50 dark:bg-rose-950" },
  "study-tips":         { color: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
  "ai-tech":            { color: "text-cyan-700 dark:text-cyan-400",    bg: "bg-cyan-50 dark:bg-cyan-950" },
  "remote-jobs":        { color: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
  "exam-results":       { color: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
  "postgraduate-guide": { color: "text-purple-700 dark:text-purple-400", bg: "bg-purple-50 dark:bg-purple-950" },
};

function getCategoryColours(slug: string) {
  return (
    CATEGORY_COLOURS[slug] ?? {
      color: "text-blue-700 dark:text-blue-400",
      bg: "bg-blue-50 dark:bg-blue-950",
    }
  );
}

// ─────────────────────────────────────────────────────────────────────
// Extract plain text from content array for excerpt/readtime calculation
// ─────────────────────────────────────────────────────────────────────

function extractPlainText(content: z.infer<typeof ContentArraySchema>): string {
  return content
    .map((section) => {
      switch (section.type) {
        case "paragraph":
        case "heading":
        case "subheading":
        case "quote":
        case "tip":
          return section.content;
        case "paragraphWithLinks":
          // Strip HTML tags for plain text
          return section.contentHtml.replace(/<[^>]+>/g, " ");
        case "list":
        case "numberedList":
          return section.items.join(" ");
        case "twoColumnList":
          return [
            ...section.leftColumnItems,
            ...section.rightColumnItems,
          ].join(" ");
        case "table":
          return section.tableRows.flat().join(" ");
        case "code":
          return section.code;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}

// ─────────────────────────────────────────────────────────────────────
// Format view count
// ─────────────────────────────────────────────────────────────────────

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────
// Format published date for display
// ─────────────────────────────────────────────────────────────────────

function formatPublishedAt(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// ─────────────────────────────────────────────────────────────────────
// DB select (shared between list and detail — detail adds content)
// ─────────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  slug: true,
  title: true,
  excerpt: true,
  coverEmoji: true,
  coverImageUrl: true,
  coverGradient: true,
  featured: true,
  status: true,
  readTimeMinutes: true,
  seoTitle: true,
  seoDescription: true,
  publishedAt: true,
  viewCount: true,
  likeCount: true,
  commentCount: true,
  shareCount: true,
  bookmarkCount: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: {
      id: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      school: true,
      verified: true,
      bio: true,
      twitterHandle: true,
      gradient: true,   // available after npx prisma db push
    },
  },
  category: {
    select: {
      id: true,
      slug: true,
      name: true,
      emoji: true,
      coverGradient: true,
    },
  },
  tags: {
    select: { tag: { select: { id: true, slug: true, name: true } } },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────
// Shape a DB row into the documented API response for POST DETAIL
// ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapePostDetail(raw: any) {
  const colours = getCategoryColours(raw.category.slug);
  const contentSections: z.infer<typeof ContentArraySchema> = (() => {
    try {
      const parsed = typeof raw.content === "string"
        ? JSON.parse(raw.content)
        : raw.content;
      return ContentArraySchema.parse(parsed);
    } catch {
      // Fallback: return a single paragraph with any existing excerpt
      return [{ type: "paragraph" as const, content: raw.excerpt ?? "" }];
    }
  })();

  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    seoTitle: raw.seoTitle ?? undefined,
    seoDescription: raw.seoDescription ?? undefined,
    excerpt: raw.excerpt,

    // Flat category fields
    category: raw.category.name,
    categorySlug: raw.category.slug,
    categoryColor: colours.color,
    categoryBg: colours.bg,

    // Cover
    coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
    coverEmoji: raw.coverEmoji ?? "📝",

    featured: raw.featured,
    tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),

    // Reading meta
    readTime: `${raw.readTimeMinutes} min read`,
    views: formatViews(raw.viewCount),
    likes: raw.likeCount,

    // Dates
    publishedAt: raw.publishedAt?.toISOString() ?? null,
    publishedAtDisplay: formatPublishedAt(raw.publishedAt),

    // Author — mapped to document format
    author: {
      name: raw.author.displayName,
      role: raw.author.role ?? "",
      school: raw.author.school ?? "",
      avatar: raw.author.displayName
        .split(" ")
        .map((w: string) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
      bio: raw.author.bio ?? "",
      twitter: raw.author.twitterHandle ?? undefined,
    },

    // Rich content array
    content: contentSections,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Shape a DB row into the documented API response for POST SUMMARY
// ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapePostSummary(raw: any) {
  const colours = getCategoryColours(raw.category.slug);
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    seoTitle: raw.seoTitle ?? undefined,
    seoDescription: raw.seoDescription ?? undefined,
    excerpt: raw.excerpt,
    category: raw.category.name,
    categorySlug: raw.category.slug,
    categoryColor: colours.color,
    categoryBg: colours.bg,
    coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
    coverEmoji: raw.coverEmoji ?? "📝",
    featured: raw.featured,
    tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),
    readTime: `${raw.readTimeMinutes} min read`,
    views: formatViews(raw.viewCount),
    likes: raw.likeCount,
    publishedAt: raw.publishedAt?.toISOString() ?? null,
    publishedAtDisplay: formatPublishedAt(raw.publishedAt),
    author: {
      name: raw.author.displayName,
      role: raw.author.role ?? "",
      school: raw.author.school ?? "",
      avatar: raw.author.displayName
        .split(" ")
        .map((w: string) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
      bio: raw.author.bio ?? "",
      twitter: raw.author.twitterHandle ?? undefined,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const PostsService = {
  async list(query: ListPostsQuery, viewerId?: string) {
    const cacheKey = CacheKeys.posts(JSON.stringify({ query, viewerId: undefined }));
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const where: Record<string, unknown> = {};

    if (!viewerId || query.status === undefined) {
      where["status"] = PostStatus.PUBLISHED;
      where["publishedAt"] = { lte: new Date() };
    } else if (query.status) {
      where["status"] = PostStatus[query.status as keyof typeof PostStatus];
    }

    if (query.category) where["category"] = { slug: query.category };
    if (query.tag)      where["tags"] = { some: { tag: { slug: query.tag } } };
    if (query.author)   where["authorId"] = query.author;
    if (query.featured !== undefined) where["featured"] = query.featured;
    if (query.search) {
      where["OR"] = [
        { title:   { contains: query.search, mode: "insensitive" } },
        { excerpt: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        select: listSelect,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    const totalPages = Math.ceil(total / query.limit);
    const result = {
      data: posts.map(shapePostSummary),
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      },
    };

    if (!viewerId) {
      await cacheSet(cacheKey, result, config.CACHE_TTL_POSTS);
    }
    return result;
  },

  // ── getBySlug — returns the full rich content shape ──────────────

  async getBySlug(slug: string) {
    const cacheKey = CacheKeys.post(slug);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const raw = await prisma.post.findFirst({
      where: {
        slug,
        status: PostStatus.PUBLISHED,
        publishedAt: { lte: new Date() },
      },
      select: {
        ...listSelect,
        content: true,   // raw JSON stored in DB
      },
    });

    if (!raw) return null;

    const shaped = shapePostDetail(raw);
    await cacheSet(cacheKey, shaped, config.CACHE_TTL_POST);
    return shaped;
  },

  // ── getById (editor use — bypasses PUBLISHED filter) ─────────────

  async getById(id: string) {
    const raw = await prisma.post.findUnique({
      where: { id },
      select: { ...listSelect, content: true, scheduledAt: true },
    });
    if (!raw) return null;
    return shapePostDetail(raw);
  },

  async create(input: CreatePostInput, authorId: string) {
    const { tags, content, excerpt, ...rest } = input;

    const slug = await uniquePostSlug(input.title);
    const plainText = extractPlainText(content);
    const readTimeMinutes = calculateReadTime(plainText);
    const finalExcerpt = excerpt ?? generateExcerpt(plainText);
    const publishedAt = input.status === "PUBLISHED" ? new Date()
      : input.scheduledAt ? new Date(input.scheduledAt) : null;

    const post = await prisma.post.create({
      data: {
        ...rest,
        slug,
        content: JSON.stringify(content),  // stored as JSON string in DB
        excerpt: finalExcerpt,
        readTimeMinutes,
        authorId,
        publishedAt,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        tags: {
          create: tags.map((tagId) => ({ tag: { connect: { id: tagId } } })),
        },
      },
      select: { ...listSelect, content: true },
    });

    if (post.status === PostStatus.PUBLISHED) {
      await publish<PostPublishedPayload>("blog.post.published", {
        postId: post.id,
        slug: post.slug,
        title: post.title,
        authorId,
        categorySlug: post.category.slug,
        tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
        publishedAt: post.publishedAt!.toISOString(),
      });
    }

    return shapePostDetail(post);
  },

  async update(id: string, input: UpdatePostInput, editorId: string) {
    const existing = await prisma.post.findUnique({
      where: { id },
      select: { title: true, content: true, slug: true, status: true },
    });
    if (!existing) return null;

    const { tags, content, excerpt, ...rest } = input;

    let readTimeMinutes: number | undefined;
    let finalExcerpt: string | undefined;
    let slug: string | undefined;
    let publishedAt: Date | undefined;

    if (content) {
      const plainText = extractPlainText(content);
      readTimeMinutes = calculateReadTime(plainText);
      finalExcerpt = excerpt ?? generateExcerpt(plainText);
    }

    if (input.title && input.title !== existing.title) {
      slug = await uniquePostSlug(input.title, id);
    }

    if (input.status === "PUBLISHED" && existing.status !== PostStatus.PUBLISHED) {
      publishedAt = new Date();
    }

    const post = await prisma.$transaction(async (tx) => {
      await tx.postRevision.create({
        data: {
          postId: id,
          title: existing.title,
          content: typeof existing.content === "string"
            ? existing.content
            : JSON.stringify(existing.content),
          editedBy: editorId,
        },
      });

      if (tags !== undefined) {
        await tx.postTag.deleteMany({ where: { postId: id } });
        if (tags.length > 0) {
          await tx.postTag.createMany({
            data: tags.map((tagId) => ({ postId: id, tagId })),
          });
        }
      }

      return tx.post.update({
        where: { id },
        data: {
          ...rest,
          ...(content && { content: JSON.stringify(content) }),
          ...(readTimeMinutes !== undefined && { readTimeMinutes }),
          ...(finalExcerpt && { excerpt: finalExcerpt }),
          ...(slug && { slug }),
          ...(publishedAt && { publishedAt }),
        },
        select: { ...listSelect, content: true },
      });
    });

    await Promise.all([
      cacheDelete(CacheKeys.post(existing.slug)),
      slug ? cacheDelete(CacheKeys.post(slug)) : Promise.resolve(),
      cacheDeletePattern("blog:posts:*"),
    ]);

    if (post.status === PostStatus.PUBLISHED && publishedAt) {
      await publish<PostPublishedPayload>("blog.post.published", {
        postId: post.id,
        slug: post.slug,
        title: post.title,
        authorId: post.author.id,
        categorySlug: post.category.slug,
        tags: [],
        publishedAt: publishedAt.toISOString(),
      });
    }

    return shapePostDetail(post);
  },

  async delete(id: string) {
    const post = await prisma.post.findUnique({
      where: { id },
      select: { slug: true },
    });
    if (!post) return false;

    await prisma.post.delete({ where: { id } });
    await Promise.all([
      cacheDelete(CacheKeys.post(post.slug)),
      cacheDeletePattern("blog:posts:*"),
    ]);
    await publish("blog.post.deleted", { postId: id, slug: post.slug });
    return true;
  },

  async recordView(postId: string, request: FastifyRequest) {
    const ipHash = crypto.createHash("sha256").update(request.ip).digest("hex");
    const userId = (request.authenticatedUser as AuthenticatedUser | undefined)?.id;
    await incrementPostViewBuffer(postId);
    prisma.postView.create({
      data: {
        postId,
        userId,
        ipHash,
        userAgent: request.headers["user-agent"]?.slice(0, 200),
        referer: request.headers.referer?.slice(0, 500),
      },
    }).catch(() => {});
  },

  async toggleReaction(postId: string, userId: string, type: "LIKE" | "BOOKMARK" | "SHARE") {
    const existing = await prisma.postReaction.findUnique({
      where: { postId_userId_type: { postId, userId, type } },
    });
    const counterField = ({ LIKE: "likeCount", BOOKMARK: "bookmarkCount", SHARE: "shareCount" } as const)[type];

    if (existing) {
      await prisma.$transaction([
        prisma.postReaction.delete({ where: { postId_userId_type: { postId, userId, type } } }),
        prisma.post.update({ where: { id: postId }, data: { [counterField]: { decrement: 1 } } }),
      ]);
      return { active: false };
    } else {
      await prisma.$transaction([
        prisma.postReaction.create({ data: { postId, userId, type } }),
        prisma.post.update({ where: { id: postId }, data: { [counterField]: { increment: 1 } } }),
      ]);
      return { active: true };
    }
  },

  async getRelated(postId: string, limit = 4) {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { categoryId: true, tags: { select: { tagId: true } } },
    });
    if (!post) return [];

    const tagIds = post.tags.map((t) => t.tagId);
    const raws = await prisma.post.findMany({
      where: {
        id: { not: postId },
        status: PostStatus.PUBLISHED,
        publishedAt: { lte: new Date() },
        OR: [
          { categoryId: post.categoryId },
          { tags: { some: { tagId: { in: tagIds } } } },
        ],
      },
      select: listSelect,
      orderBy: { publishedAt: "desc" },
      take: limit,
    });
    return raws.map(shapePostSummary);
  },

  async getRevisions(postId: string) {
    return prisma.postRevision.findMany({
      where: { postId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────────────

async function listPosts(request: FastifyRequest, reply: FastifyReply) {
  const query = ListPostsQuerySchema.parse(request.query);
  const result = await PostsService.list(query, request.authenticatedUser?.id);
  return reply.send({ success: true, ...result });
}

async function getPost(
  request: FastifyRequest<{ Params: { slug: string } }>,
  reply: FastifyReply
) {
  const post = await PostsService.getBySlug(request.params.slug);
  if (!post) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Post not found" },
    });
  }
  PostsService.recordView((post as { id: string }).id, request).catch(() => {});
  return reply.send({ success: true, data: post });
}

async function createPost(request: FastifyRequest, reply: FastifyReply) {
  const input = CreatePostSchema.parse(request.body);
  const authorId = (request.authenticatedUser as AuthenticatedUser).id;
  const post = await PostsService.create(input, authorId);
  return reply.code(201).send({ success: true, data: post });
}

async function updatePost(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const input = UpdatePostSchema.parse(request.body);
  const editorId = (request.authenticatedUser as AuthenticatedUser).id;
  const post = await PostsService.update(request.params.id, input, editorId);
  if (!post) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Post not found" },
    });
  }
  return reply.send({ success: true, data: post });
}

async function deletePost(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const deleted = await PostsService.delete(request.params.id);
  if (!deleted) {
    return reply.code(404).send({
      success: false,
      error: { code: "NOT_FOUND", message: "Post not found" },
    });
  }
  return reply.code(204).send();
}

async function toggleReaction(
  request: FastifyRequest<{ Params: { id: string }; Body: { type: string } }>,
  reply: FastifyReply
) {
  const { type } = z.object({ type: z.enum(["LIKE", "BOOKMARK", "SHARE"]) }).parse(request.body);
  const userId = (request.authenticatedUser as AuthenticatedUser).id;
  const result = await PostsService.toggleReaction(request.params.id, userId, type);
  return reply.send({ success: true, data: result });
}

async function getRelatedPosts(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const posts = await PostsService.getRelated(request.params.id);
  return reply.send({ success: true, data: posts });
}

async function getRevisions(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const revisions = await PostsService.getRevisions(request.params.id);
  return reply.send({ success: true, data: revisions });
}

// ─────────────────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────────────────

export async function postsRoutes(fastify: FastifyInstance) {
  fastify.get("/posts", { preHandler: [optionalAuthenticate] }, listPosts);
  fastify.get<{ Params: { slug: string } }>("/posts/:slug", { preHandler: [optionalAuthenticate] }, getPost);
  fastify.get<{ Params: { id: string } }>("/posts/:id/related", getRelatedPosts);
  fastify.post("/posts", { preHandler: [authenticate, requireEditor] }, createPost);
  fastify.patch<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, updatePost);
  fastify.delete<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, deletePost);
  fastify.post<{ Params: { id: string }; Body: { type: string } }>("/posts/:id/react", { preHandler: [authenticate] }, toggleReaction);

  // Public like — no auth needed, just increments likeCount
  fastify.post<{ Params: { id: string } }>("/posts/:id/like", async (request, reply) => {
    const postId = request.params.id;
    const post   = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) return reply.code(404).send({ success: false, error: { code: "NOT_FOUND", message: "Post not found" } });
    const updated = await prisma.post.update({
      where: { id: postId },
      data:  { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    await cacheDelete(CacheKeys.post(postId));
    return reply.send({ success: true, data: { likeCount: updated.likeCount } });
  });
  fastify.get<{ Params: { id: string } }>("/posts/:id/revisions", { preHandler: [authenticate, requireEditor] }, getRevisions);
}



// // src/modules/posts/index.ts
// // Posts module — updated getBySlug to return the rich content format
// // matching the documented API shape with all 12 content section types.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import {
//   cacheGet, cacheSet, cacheDelete, cacheDeletePattern, incrementPostViewBuffer,
//   CacheKeys,
// } from "../../lib/redis";
// import {
//   uniquePostSlug, calculateReadTime, generateExcerpt,
// } from "../../lib/content";
// import { authenticate, optionalAuthenticate, requireEditor } from "../../middleware/auth";
// import { config } from "../../config";
// import type { AuthenticatedUser, PostPublishedPayload } from "../../types";
// import crypto from "crypto";

// // ─────────────────────────────────────────────────────────────────────
// // Content section schema (Zod)
// // Validates the JSON stored in the `content` DB column.
// // ─────────────────────────────────────────────────────────────────────

// const ParagraphSectionSchema = z.object({
//   type: z.literal("paragraph"),
//   content: z.string(),
// });

// const ParagraphWithLinksSectionSchema = z.object({
//   type: z.literal("paragraphWithLinks"),
//   contentHtml: z.string(),
// });

// const HeadingSectionSchema = z.object({
//   type: z.literal("heading"),
//   content: z.string(),
// });

// const SubheadingSectionSchema = z.object({
//   type: z.literal("subheading"),
//   content: z.string(),
// });

// const QuoteSectionSchema = z.object({
//   type: z.literal("quote"),
//   content: z.string(),
// });

// const TipSectionSchema = z.object({
//   type: z.literal("tip"),
//   content: z.string(),
// });

// const ListSectionSchema = z.object({
//   type: z.literal("list"),
//   items: z.array(z.string()),
// });

// const NumberedListSectionSchema = z.object({
//   type: z.literal("numberedList"),
//   items: z.array(z.string()),
// });

// const TwoColumnListSectionSchema = z.object({
//   type: z.literal("twoColumnList"),
//   leftColumnTitle: z.string(),
//   leftColumnItems: z.array(z.string()),
//   rightColumnTitle: z.string(),
//   rightColumnItems: z.array(z.string()),
// });

// const ImageSectionSchema = z.object({
//   type: z.literal("image"),
//   imageUrl: z.string(),
//   altText: z.string(),
//   caption: z.string().optional(),
//   width: z.number().optional(),
//   height: z.number().optional(),
// });

// const VideoSectionSchema = z.object({
//   type: z.literal("video"),
//   videoType: z.enum(["youtube", "native"]),
//   videoId: z.string().optional(),
//   videoUrl: z.string().optional(),
//   videoTitle: z.string(),
//   caption: z.string().optional(),
//   thumbnailUrl: z.string().optional(),
// });

// const TableSectionSchema = z.object({
//   type: z.literal("table"),
//   tableHeaders: z.array(z.string()),
//   tableRows: z.array(z.array(z.string())),
//   tableCaption: z.string().optional(),
// });

// const CodeSectionSchema = z.object({
//   type: z.literal("code"),
//   code: z.string(),
//   codeLanguage: z.string().optional(),
// });

// const CtaSectionSchema = z.object({
//   type: z.literal("cta"),
//   ctaTitle: z.string(),
//   ctaDescription: z.string(),
//   ctaButtonText: z.string(),
//   ctaLink: z.string(),
//   ctaNewTab: z.boolean().optional(),
// });

// const DividerSectionSchema = z.object({
//   type: z.literal("divider"),
// });

// const BlogContentSectionSchema = z.discriminatedUnion("type", [
//   ParagraphSectionSchema,
//   ParagraphWithLinksSectionSchema,
//   HeadingSectionSchema,
//   SubheadingSectionSchema,
//   QuoteSectionSchema,
//   TipSectionSchema,
//   ListSectionSchema,
//   NumberedListSectionSchema,
//   TwoColumnListSectionSchema,
//   ImageSectionSchema,
//   VideoSectionSchema,
//   TableSectionSchema,
//   CodeSectionSchema,
//   CtaSectionSchema,
//   DividerSectionSchema,
// ]);

// const ContentArraySchema = z.array(BlogContentSectionSchema);

// // ─────────────────────────────────────────────────────────────────────
// // Request schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreatePostSchema = z.object({
//   title: z.string().min(5).max(200),
//   excerpt: z.string().max(500).optional(),
//   content: z.array(BlogContentSectionSchema).min(1),  // rich content array
//   categoryId: z.string().cuid("Invalid category ID"),
//   tags: z.array(z.string().cuid()).max(10).default([]),
//   coverEmoji: z.string().max(4).optional(),
//   coverGradient: z.string().max(100).optional(),
//   featured: z.boolean().default(false),
//   status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED"]).default("DRAFT"),
//   scheduledAt: z.string().datetime().optional(),
//   seoTitle: z.string().max(70).optional(),
//   seoDescription: z.string().max(160).optional(),
//   readTime: z.string().optional(),      // e.g. "6 min read" — auto-calculated if omitted
//   views: z.string().optional(),         // e.g. "0" — starts at 0
// });

// const UpdatePostSchema = CreatePostSchema.partial();

// const ListPostsQuerySchema = z.object({
//   page:      z.coerce.number().int().min(1).default(1),
//   limit:     z.coerce.number().int().min(1).max(200).default(12), // 200 allows blogPosts(100) & getAllTags()
//   category:  z.string().optional(),
//   tag:       z.string().optional(),
//   author:    z.string().optional(),
//   status:    z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
//   featured:  z.coerce.boolean().optional(),
//   search:    z.string().max(200).optional(),
//   sortBy:    z.enum(["publishedAt", "likeCount", "viewCount", "createdAt"]).default("publishedAt"),
//   sortOrder: z.enum(["asc", "desc"]).default("desc"),
// });

// type CreatePostInput = z.infer<typeof CreatePostSchema>;
// type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
// type ListPostsQuery  = z.infer<typeof ListPostsQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Category colour map — injected into responses so frontend is data-driven
// // ─────────────────────────────────────────────────────────────────────

// const CATEGORY_COLOURS: Record<string, { color: string; bg: string }> = {
//   "exam-prep":          { color: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
//   "earn-grow":          { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
//   "scholarships":       { color: "text-rose-700 dark:text-rose-400",    bg: "bg-rose-50 dark:bg-rose-950" },
//   "study-tips":         { color: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
//   "ai-tech":            { color: "text-cyan-700 dark:text-cyan-400",    bg: "bg-cyan-50 dark:bg-cyan-950" },
//   "remote-jobs":        { color: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
//   "exam-results":       { color: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
//   "postgraduate-guide": { color: "text-purple-700 dark:text-purple-400", bg: "bg-purple-50 dark:bg-purple-950" },
// };

// function getCategoryColours(slug: string) {
//   return (
//     CATEGORY_COLOURS[slug] ?? {
//       color: "text-blue-700 dark:text-blue-400",
//       bg: "bg-blue-50 dark:bg-blue-950",
//     }
//   );
// }

// // ─────────────────────────────────────────────────────────────────────
// // Extract plain text from content array for excerpt/readtime calculation
// // ─────────────────────────────────────────────────────────────────────

// function extractPlainText(content: z.infer<typeof ContentArraySchema>): string {
//   return content
//     .map((section) => {
//       switch (section.type) {
//         case "paragraph":
//         case "heading":
//         case "subheading":
//         case "quote":
//         case "tip":
//           return section.content;
//         case "paragraphWithLinks":
//           // Strip HTML tags for plain text
//           return section.contentHtml.replace(/<[^>]+>/g, " ");
//         case "list":
//         case "numberedList":
//           return section.items.join(" ");
//         case "twoColumnList":
//           return [
//             ...section.leftColumnItems,
//             ...section.rightColumnItems,
//           ].join(" ");
//         case "table":
//           return section.tableRows.flat().join(" ");
//         case "code":
//           return section.code;
//         default:
//           return "";
//       }
//     })
//     .filter(Boolean)
//     .join(" ");
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format view count
// // ─────────────────────────────────────────────────────────────────────

// function formatViews(n: number): string {
//   if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
//   if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
//   return String(n);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format published date for display
// // ─────────────────────────────────────────────────────────────────────

// function formatPublishedAt(date: Date | null): string {
//   if (!date) return "";
//   return date.toLocaleDateString("en-NG", {
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });
// }

// // ─────────────────────────────────────────────────────────────────────
// // DB select (shared between list and detail — detail adds content)
// // ─────────────────────────────────────────────────────────────────────

// const listSelect = {
//   id: true,
//   slug: true,
//   title: true,
//   excerpt: true,
//   coverEmoji: true,
//   coverImageUrl: true,
//   coverGradient: true,
//   featured: true,
//   status: true,
//   readTimeMinutes: true,
//   seoTitle: true,
//   seoDescription: true,
//   publishedAt: true,
//   viewCount: true,
//   likeCount: true,
//   commentCount: true,
//   shareCount: true,
//   bookmarkCount: true,
//   createdAt: true,
//   updatedAt: true,
//   author: {
//     select: {
//       id: true,
//       displayName: true,
//       avatarUrl: true,
//       role: true,
//       school: true,
//       verified: true,
//       bio: true,
//       twitterHandle: true,
//       // gradient is selected only after migration 20250418_add_author_gradient is applied.
//       // Until then the fallback in shapePostSummary/shapePostDetail is used.
//     },
//   },
//   category: {
//     select: {
//       id: true,
//       slug: true,
//       name: true,
//       emoji: true,
//       coverGradient: true,
//     },
//   },
//   tags: {
//     select: { tag: { select: { id: true, slug: true, name: true } } },
//   },
// } as const;

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST DETAIL
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostDetail(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   const contentSections: z.infer<typeof ContentArraySchema> = (() => {
//     try {
//       const parsed = typeof raw.content === "string"
//         ? JSON.parse(raw.content)
//         : raw.content;
//       return ContentArraySchema.parse(parsed);
//     } catch {
//       // Fallback: return a single paragraph with any existing excerpt
//       return [{ type: "paragraph" as const, content: raw.excerpt ?? "" }];
//     }
//   })();

//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     seoTitle: raw.seoTitle ?? undefined,
//     seoDescription: raw.seoDescription ?? undefined,
//     excerpt: raw.excerpt,

//     // Flat category fields
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,

//     // Cover
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",

//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),

//     // Reading meta
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,

//     // Dates
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),

//     // Author — mapped to document format
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },

//     // Rich content array
//     content: contentSections,
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST SUMMARY
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostSummary(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     seoTitle: raw.seoTitle ?? undefined,
//     seoDescription: raw.seoDescription ?? undefined,
//     excerpt: raw.excerpt,
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",
//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const PostsService = {
//   async list(query: ListPostsQuery, viewerId?: string) {
//     const cacheKey = CacheKeys.posts(JSON.stringify({ query, viewerId: undefined }));
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const where: Record<string, unknown> = {};

//     if (!viewerId || query.status === undefined) {
//       where["status"] = PostStatus.PUBLISHED;
//       where["publishedAt"] = { lte: new Date() };
//     } else if (query.status) {
//       where["status"] = PostStatus[query.status as keyof typeof PostStatus];
//     }

//     if (query.category) where["category"] = { slug: query.category };
//     if (query.tag)      where["tags"] = { some: { tag: { slug: query.tag } } };
//     if (query.author)   where["authorId"] = query.author;
//     if (query.featured !== undefined) where["featured"] = query.featured;
//     if (query.search) {
//       where["OR"] = [
//         { title:   { contains: query.search, mode: "insensitive" } },
//         { excerpt: { contains: query.search, mode: "insensitive" } },
//       ];
//     }

//     const [total, posts] = await Promise.all([
//       prisma.post.count({ where }),
//       prisma.post.findMany({
//         where,
//         select: listSelect,
//         orderBy: { [query.sortBy]: query.sortOrder },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: posts.map(shapePostSummary),
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!viewerId) {
//       await cacheSet(cacheKey, result, config.CACHE_TTL_POSTS);
//     }
//     return result;
//   },

//   // ── getBySlug — returns the full rich content shape ──────────────

//   async getBySlug(slug: string) {
//     const cacheKey = CacheKeys.post(slug);
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const raw = await prisma.post.findFirst({
//       where: {
//         slug,
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//       },
//       select: {
//         ...listSelect,
//         content: true,   // raw JSON stored in DB
//       },
//     });

//     if (!raw) return null;

//     const shaped = shapePostDetail(raw);
//     await cacheSet(cacheKey, shaped, config.CACHE_TTL_POST);
//     return shaped;
//   },

//   // ── getById (editor use — bypasses PUBLISHED filter) ─────────────

//   async getById(id: string) {
//     const raw = await prisma.post.findUnique({
//       where: { id },
//       select: { ...listSelect, content: true, scheduledAt: true },
//     });
//     if (!raw) return null;
//     return shapePostDetail(raw);
//   },

//   async create(input: CreatePostInput, authorId: string) {
//     const { tags, content, excerpt, ...rest } = input;

//     const slug = await uniquePostSlug(input.title);
//     const plainText = extractPlainText(content);
//     const readTimeMinutes = calculateReadTime(plainText);
//     const finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     const publishedAt = input.status === "PUBLISHED" ? new Date()
//       : input.scheduledAt ? new Date(input.scheduledAt) : null;

//     const post = await prisma.post.create({
//       data: {
//         ...rest,
//         slug,
//         content: JSON.stringify(content),  // stored as JSON string in DB
//         excerpt: finalExcerpt,
//         readTimeMinutes,
//         authorId,
//         publishedAt,
//         scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
//         tags: {
//           create: tags.map((tagId) => ({ tag: { connect: { id: tagId } } })),
//         },
//       },
//       select: { ...listSelect, content: true },
//     });

//     if (post.status === PostStatus.PUBLISHED) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId,
//         categorySlug: post.category.slug,
//         tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
//         publishedAt: post.publishedAt!.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async update(id: string, input: UpdatePostInput, editorId: string) {
//     const existing = await prisma.post.findUnique({
//       where: { id },
//       select: { title: true, content: true, slug: true, status: true },
//     });
//     if (!existing) return null;

//     const { tags, content, excerpt, ...rest } = input;

//     let readTimeMinutes: number | undefined;
//     let finalExcerpt: string | undefined;
//     let slug: string | undefined;
//     let publishedAt: Date | undefined;

//     if (content) {
//       const plainText = extractPlainText(content);
//       readTimeMinutes = calculateReadTime(plainText);
//       finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     }

//     if (input.title && input.title !== existing.title) {
//       slug = await uniquePostSlug(input.title, id);
//     }

//     if (input.status === "PUBLISHED" && existing.status !== PostStatus.PUBLISHED) {
//       publishedAt = new Date();
//     }

//     const post = await prisma.$transaction(async (tx) => {
//       await tx.postRevision.create({
//         data: {
//           postId: id,
//           title: existing.title,
//           content: typeof existing.content === "string"
//             ? existing.content
//             : JSON.stringify(existing.content),
//           editedBy: editorId,
//         },
//       });

//       if (tags !== undefined) {
//         await tx.postTag.deleteMany({ where: { postId: id } });
//         if (tags.length > 0) {
//           await tx.postTag.createMany({
//             data: tags.map((tagId) => ({ postId: id, tagId })),
//           });
//         }
//       }

//       return tx.post.update({
//         where: { id },
//         data: {
//           ...rest,
//           ...(content && { content: JSON.stringify(content) }),
//           ...(readTimeMinutes !== undefined && { readTimeMinutes }),
//           ...(finalExcerpt && { excerpt: finalExcerpt }),
//           ...(slug && { slug }),
//           ...(publishedAt && { publishedAt }),
//         },
//         select: { ...listSelect, content: true },
//       });
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.post(existing.slug)),
//       slug ? cacheDelete(CacheKeys.post(slug)) : Promise.resolve(),
//       cacheDeletePattern("blog:posts:*"),
//     ]);

//     if (post.status === PostStatus.PUBLISHED && publishedAt) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId: post.author.id,
//         categorySlug: post.category.slug,
//         tags: [],
//         publishedAt: publishedAt.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async delete(id: string) {
//     const post = await prisma.post.findUnique({
//       where: { id },
//       select: { slug: true },
//     });
//     if (!post) return false;

//     await prisma.post.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.post(post.slug)),
//       cacheDeletePattern("blog:posts:*"),
//     ]);
//     await publish("blog.post.deleted", { postId: id, slug: post.slug });
//     return true;
//   },

//   async recordView(postId: string, request: FastifyRequest) {
//     const ipHash = crypto.createHash("sha256").update(request.ip).digest("hex");
//     const userId = (request.user as AuthenticatedUser | undefined)?.id;
//     await incrementPostViewBuffer(postId);
//     prisma.postView.create({
//       data: {
//         postId,
//         userId,
//         ipHash,
//         userAgent: request.headers["user-agent"]?.slice(0, 200),
//         referer: request.headers.referer?.slice(0, 500),
//       },
//     }).catch(() => {});
//   },

//   async toggleReaction(postId: string, userId: string, type: "LIKE" | "BOOKMARK" | "SHARE") {
//     const existing = await prisma.postReaction.findUnique({
//       where: { postId_userId_type: { postId, userId, type } },
//     });
//     const counterField = ({ LIKE: "likeCount", BOOKMARK: "bookmarkCount", SHARE: "shareCount" } as const)[type];

//     if (existing) {
//       await prisma.$transaction([
//         prisma.postReaction.delete({ where: { postId_userId_type: { postId, userId, type } } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { decrement: 1 } } }),
//       ]);
//       return { active: false };
//     } else {
//       await prisma.$transaction([
//         prisma.postReaction.create({ data: { postId, userId, type } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { increment: 1 } } }),
//       ]);
//       return { active: true };
//     }
//   },

//   async getRelated(postId: string, limit = 4) {
//     const post = await prisma.post.findUnique({
//       where: { id: postId },
//       select: { categoryId: true, tags: { select: { tagId: true } } },
//     });
//     if (!post) return [];

//     const tagIds = post.tags.map((t) => t.tagId);
//     const raws = await prisma.post.findMany({
//       where: {
//         id: { not: postId },
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//         OR: [
//           { categoryId: post.categoryId },
//           { tags: { some: { tagId: { in: tagIds } } } },
//         ],
//       },
//       select: listSelect,
//       orderBy: { publishedAt: "desc" },
//       take: limit,
//     });
//     return raws.map(shapePostSummary);
//   },

//   async getRevisions(postId: string) {
//     return prisma.postRevision.findMany({
//       where: { postId },
//       orderBy: { createdAt: "desc" },
//       take: 20,
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listPosts(request: FastifyRequest, reply: FastifyReply) {
//   const query = ListPostsQuerySchema.parse(request.query);
//   const result = await PostsService.list(query, request.user?.id);
//   return reply.send({ success: true, ...result });
// }

// async function getPost(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const post = await PostsService.getBySlug(request.params.slug);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   PostsService.recordView((post as { id: string }).id, request).catch(() => {});
//   return reply.send({ success: true, data: post });
// }

// async function createPost(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreatePostSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.create(input, authorId);
//   return reply.code(201).send({ success: true, data: post });
// }

// async function updatePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePostSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.update(request.params.id, input, editorId);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.send({ success: true, data: post });
// }

// async function deletePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const deleted = await PostsService.delete(request.params.id);
//   if (!deleted) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.code(204).send();
// }

// async function toggleReaction(
//   request: FastifyRequest<{ Params: { id: string }; Body: { type: string } }>,
//   reply: FastifyReply
// ) {
//   const { type } = z.object({ type: z.enum(["LIKE", "BOOKMARK", "SHARE"]) }).parse(request.body);
//   const userId = (request.user as AuthenticatedUser).id;
//   const result = await PostsService.toggleReaction(request.params.id, userId, type);
//   return reply.send({ success: true, data: result });
// }

// async function getRelatedPosts(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const posts = await PostsService.getRelated(request.params.id);
//   return reply.send({ success: true, data: posts });
// }

// async function getRevisions(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const revisions = await PostsService.getRevisions(request.params.id);
//   return reply.send({ success: true, data: revisions });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function postsRoutes(fastify: FastifyInstance) {
//   fastify.get("/posts", { preHandler: [optionalAuthenticate] }, listPosts);
//   fastify.get<{ Params: { slug: string } }>("/posts/:slug", { preHandler: [optionalAuthenticate] }, getPost);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/related", getRelatedPosts);
//   fastify.post("/posts", { preHandler: [authenticate, requireEditor] }, createPost);
//   fastify.patch<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, updatePost);
//   fastify.delete<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, deletePost);
//   fastify.post<{ Params: { id: string }; Body: { type: string } }>("/posts/:id/react", { preHandler: [authenticate] }, toggleReaction);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/revisions", { preHandler: [authenticate, requireEditor] }, getRevisions);
// }




// // src/modules/posts/index.ts
// // Posts module — updated getBySlug to return the rich content format
// // matching the documented API shape with all 12 content section types.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import {
//   cacheGet, cacheSet, cacheDelete, cacheDeletePattern, incrementPostViewBuffer,
//   CacheKeys,
// } from "../../lib/redis";
// import {
//   uniquePostSlug, calculateReadTime, generateExcerpt,
// } from "../../lib/content";
// import { authenticate, optionalAuthenticate, requireEditor } from "../../middleware/auth";
// import { config } from "../../config";
// import type { AuthenticatedUser, PostPublishedPayload } from "../../types";
// import crypto from "crypto";

// // ─────────────────────────────────────────────────────────────────────
// // Content section schema (Zod)
// // Validates the JSON stored in the `content` DB column.
// // ─────────────────────────────────────────────────────────────────────

// const ParagraphSectionSchema = z.object({
//   type: z.literal("paragraph"),
//   content: z.string(),
// });

// const ParagraphWithLinksSectionSchema = z.object({
//   type: z.literal("paragraphWithLinks"),
//   contentHtml: z.string(),
// });

// const HeadingSectionSchema = z.object({
//   type: z.literal("heading"),
//   content: z.string(),
// });

// const SubheadingSectionSchema = z.object({
//   type: z.literal("subheading"),
//   content: z.string(),
// });

// const QuoteSectionSchema = z.object({
//   type: z.literal("quote"),
//   content: z.string(),
// });

// const TipSectionSchema = z.object({
//   type: z.literal("tip"),
//   content: z.string(),
// });

// const ListSectionSchema = z.object({
//   type: z.literal("list"),
//   items: z.array(z.string()),
// });

// const NumberedListSectionSchema = z.object({
//   type: z.literal("numberedList"),
//   items: z.array(z.string()),
// });

// const TwoColumnListSectionSchema = z.object({
//   type: z.literal("twoColumnList"),
//   leftColumnTitle: z.string(),
//   leftColumnItems: z.array(z.string()),
//   rightColumnTitle: z.string(),
//   rightColumnItems: z.array(z.string()),
// });

// const ImageSectionSchema = z.object({
//   type: z.literal("image"),
//   imageUrl: z.string(),
//   altText: z.string(),
//   caption: z.string().optional(),
//   width: z.number().optional(),
//   height: z.number().optional(),
// });

// const VideoSectionSchema = z.object({
//   type: z.literal("video"),
//   videoType: z.enum(["youtube", "native"]),
//   videoId: z.string().optional(),
//   videoUrl: z.string().optional(),
//   videoTitle: z.string(),
//   caption: z.string().optional(),
//   thumbnailUrl: z.string().optional(),
// });

// const TableSectionSchema = z.object({
//   type: z.literal("table"),
//   tableHeaders: z.array(z.string()),
//   tableRows: z.array(z.array(z.string())),
//   tableCaption: z.string().optional(),
// });

// const CodeSectionSchema = z.object({
//   type: z.literal("code"),
//   code: z.string(),
//   codeLanguage: z.string().optional(),
// });

// const CtaSectionSchema = z.object({
//   type: z.literal("cta"),
//   ctaTitle: z.string(),
//   ctaDescription: z.string(),
//   ctaButtonText: z.string(),
//   ctaLink: z.string(),
//   ctaNewTab: z.boolean().optional(),
// });

// const DividerSectionSchema = z.object({
//   type: z.literal("divider"),
// });

// const BlogContentSectionSchema = z.discriminatedUnion("type", [
//   ParagraphSectionSchema,
//   ParagraphWithLinksSectionSchema,
//   HeadingSectionSchema,
//   SubheadingSectionSchema,
//   QuoteSectionSchema,
//   TipSectionSchema,
//   ListSectionSchema,
//   NumberedListSectionSchema,
//   TwoColumnListSectionSchema,
//   ImageSectionSchema,
//   VideoSectionSchema,
//   TableSectionSchema,
//   CodeSectionSchema,
//   CtaSectionSchema,
//   DividerSectionSchema,
// ]);

// const ContentArraySchema = z.array(BlogContentSectionSchema);

// // ─────────────────────────────────────────────────────────────────────
// // Request schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreatePostSchema = z.object({
//   title: z.string().min(5).max(200),
//   excerpt: z.string().max(500).optional(),
//   content: z.array(BlogContentSectionSchema).min(1),  // rich content array
//   categoryId: z.string().cuid("Invalid category ID"),
//   tags: z.array(z.string().cuid()).max(10).default([]),
//   coverEmoji: z.string().max(4).optional(),
//   coverGradient: z.string().max(100).optional(),
//   featured: z.boolean().default(false),
//   status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED"]).default("DRAFT"),
//   scheduledAt: z.string().datetime().optional(),
//   seoTitle: z.string().max(70).optional(),
//   seoDescription: z.string().max(160).optional(),
//   readTime: z.string().optional(),      // e.g. "6 min read" — auto-calculated if omitted
//   views: z.string().optional(),         // e.g. "0" — starts at 0
// });

// const UpdatePostSchema = CreatePostSchema.partial();

// const ListPostsQuerySchema = z.object({
//   page:      z.coerce.number().int().min(1).default(1),
//   limit:     z.coerce.number().int().min(1).max(200).default(12), // 200 allows blogPosts(100) & getAllTags()
//   category:  z.string().optional(),
//   tag:       z.string().optional(),
//   author:    z.string().optional(),
//   status:    z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
//   featured:  z.coerce.boolean().optional(),
//   search:    z.string().max(200).optional(),
//   sortBy:    z.enum(["publishedAt", "likeCount", "viewCount", "createdAt"]).default("publishedAt"),
//   sortOrder: z.enum(["asc", "desc"]).default("desc"),
// });

// type CreatePostInput = z.infer<typeof CreatePostSchema>;
// type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
// type ListPostsQuery  = z.infer<typeof ListPostsQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Category colour map — injected into responses so frontend is data-driven
// // ─────────────────────────────────────────────────────────────────────

// const CATEGORY_COLOURS: Record<string, { color: string; bg: string }> = {
//   "exam-prep":          { color: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
//   "earn-grow":          { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
//   "scholarships":       { color: "text-rose-700 dark:text-rose-400",    bg: "bg-rose-50 dark:bg-rose-950" },
//   "study-tips":         { color: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
//   "ai-tech":            { color: "text-cyan-700 dark:text-cyan-400",    bg: "bg-cyan-50 dark:bg-cyan-950" },
//   "remote-jobs":        { color: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
//   "exam-results":       { color: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
//   "postgraduate-guide": { color: "text-purple-700 dark:text-purple-400", bg: "bg-purple-50 dark:bg-purple-950" },
// };

// function getCategoryColours(slug: string) {
//   return (
//     CATEGORY_COLOURS[slug] ?? {
//       color: "text-blue-700 dark:text-blue-400",
//       bg: "bg-blue-50 dark:bg-blue-950",
//     }
//   );
// }

// // ─────────────────────────────────────────────────────────────────────
// // Extract plain text from content array for excerpt/readtime calculation
// // ─────────────────────────────────────────────────────────────────────

// function extractPlainText(content: z.infer<typeof ContentArraySchema>): string {
//   return content
//     .map((section) => {
//       switch (section.type) {
//         case "paragraph":
//         case "heading":
//         case "subheading":
//         case "quote":
//         case "tip":
//           return section.content;
//         case "paragraphWithLinks":
//           // Strip HTML tags for plain text
//           return section.contentHtml.replace(/<[^>]+>/g, " ");
//         case "list":
//         case "numberedList":
//           return section.items.join(" ");
//         case "twoColumnList":
//           return [
//             ...section.leftColumnItems,
//             ...section.rightColumnItems,
//           ].join(" ");
//         case "table":
//           return section.tableRows.flat().join(" ");
//         case "code":
//           return section.code;
//         default:
//           return "";
//       }
//     })
//     .filter(Boolean)
//     .join(" ");
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format view count
// // ─────────────────────────────────────────────────────────────────────

// function formatViews(n: number): string {
//   if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
//   if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
//   return String(n);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format published date for display
// // ─────────────────────────────────────────────────────────────────────

// function formatPublishedAt(date: Date | null): string {
//   if (!date) return "";
//   return date.toLocaleDateString("en-NG", {
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });
// }

// // ─────────────────────────────────────────────────────────────────────
// // DB select (shared between list and detail — detail adds content)
// // ─────────────────────────────────────────────────────────────────────

// const listSelect = {
//   id: true,
//   slug: true,
//   title: true,
//   excerpt: true,
//   coverEmoji: true,
//   coverImageUrl: true,
//   coverGradient: true,
//   featured: true,
//   status: true,
//   readTimeMinutes: true,
//   seoTitle: true,
//   seoDescription: true,
//   publishedAt: true,
//   viewCount: true,
//   likeCount: true,
//   commentCount: true,
//   shareCount: true,
//   bookmarkCount: true,
//   createdAt: true,
//   updatedAt: true,
//   author: {
//     select: {
//       id: true,
//       displayName: true,
//       avatarUrl: true,
//       role: true,
//       school: true,
//       verified: true,
//       bio: true,
//       twitterHandle: true,
//       // gradient is selected only after migration 20250418_add_author_gradient is applied.
//       // Until then the fallback in shapePostSummary/shapePostDetail is used.
//     },
//   },
//   category: {
//     select: {
//       id: true,
//       slug: true,
//       name: true,
//       emoji: true,
//       coverGradient: true,
//     },
//   },
//   tags: {
//     select: { tag: { select: { id: true, slug: true, name: true } } },
//   },
// } as const;

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST DETAIL
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostDetail(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   const contentSections: z.infer<typeof ContentArraySchema> = (() => {
//     try {
//       const parsed = typeof raw.content === "string"
//         ? JSON.parse(raw.content)
//         : raw.content;
//       return ContentArraySchema.parse(parsed);
//     } catch {
//       // Fallback: return a single paragraph with any existing excerpt
//       return [{ type: "paragraph" as const, content: raw.excerpt ?? "" }];
//     }
//   })();

//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     seoTitle: raw.seoTitle ?? undefined,
//     seoDescription: raw.seoDescription ?? undefined,
//     excerpt: raw.excerpt,

//     // Flat category fields
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,

//     // Cover
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",

//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),

//     // Reading meta
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,

//     // Dates
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),

//     // Author — mapped to document format
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },

//     // Rich content array
//     content: contentSections,
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST SUMMARY
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostSummary(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     excerpt: raw.excerpt,
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",
//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: raw.author.gradient ?? "from-blue-600 to-indigo-600",
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const PostsService = {
//   async list(query: ListPostsQuery, viewerId?: string) {
//     const cacheKey = CacheKeys.posts(JSON.stringify({ query, viewerId: undefined }));
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const where: Record<string, unknown> = {};

//     if (!viewerId || query.status === undefined) {
//       where["status"] = PostStatus.PUBLISHED;
//       where["publishedAt"] = { lte: new Date() };
//     } else if (query.status) {
//       where["status"] = PostStatus[query.status as keyof typeof PostStatus];
//     }

//     if (query.category) where["category"] = { slug: query.category };
//     if (query.tag)      where["tags"] = { some: { tag: { slug: query.tag } } };
//     if (query.author)   where["authorId"] = query.author;
//     if (query.featured !== undefined) where["featured"] = query.featured;
//     if (query.search) {
//       where["OR"] = [
//         { title:   { contains: query.search, mode: "insensitive" } },
//         { excerpt: { contains: query.search, mode: "insensitive" } },
//       ];
//     }

//     const [total, posts] = await Promise.all([
//       prisma.post.count({ where }),
//       prisma.post.findMany({
//         where,
//         select: listSelect,
//         orderBy: { [query.sortBy]: query.sortOrder },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: posts.map(shapePostSummary),
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!viewerId) {
//       await cacheSet(cacheKey, result, config.CACHE_TTL_POSTS);
//     }
//     return result;
//   },

//   // ── getBySlug — returns the full rich content shape ──────────────

//   async getBySlug(slug: string) {
//     const cacheKey = CacheKeys.post(slug);
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const raw = await prisma.post.findFirst({
//       where: {
//         slug,
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//       },
//       select: {
//         ...listSelect,
//         content: true,   // raw JSON stored in DB
//       },
//     });

//     if (!raw) return null;

//     const shaped = shapePostDetail(raw);
//     await cacheSet(cacheKey, shaped, config.CACHE_TTL_POST);
//     return shaped;
//   },

//   // ── getById (editor use — bypasses PUBLISHED filter) ─────────────

//   async getById(id: string) {
//     const raw = await prisma.post.findUnique({
//       where: { id },
//       select: { ...listSelect, content: true, scheduledAt: true },
//     });
//     if (!raw) return null;
//     return shapePostDetail(raw);
//   },

//   async create(input: CreatePostInput, authorId: string) {
//     const { tags, content, excerpt, ...rest } = input;

//     const slug = await uniquePostSlug(input.title);
//     const plainText = extractPlainText(content);
//     const readTimeMinutes = calculateReadTime(plainText);
//     const finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     const publishedAt = input.status === "PUBLISHED" ? new Date()
//       : input.scheduledAt ? new Date(input.scheduledAt) : null;

//     const post = await prisma.post.create({
//       data: {
//         ...rest,
//         slug,
//         content: JSON.stringify(content),  // stored as JSON string in DB
//         excerpt: finalExcerpt,
//         readTimeMinutes,
//         authorId,
//         publishedAt,
//         scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
//         tags: {
//           create: tags.map((tagId) => ({ tag: { connect: { id: tagId } } })),
//         },
//       },
//       select: { ...listSelect, content: true },
//     });

//     if (post.status === PostStatus.PUBLISHED) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId,
//         categorySlug: post.category.slug,
//         tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
//         publishedAt: post.publishedAt!.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async update(id: string, input: UpdatePostInput, editorId: string) {
//     const existing = await prisma.post.findUnique({
//       where: { id },
//       select: { title: true, content: true, slug: true, status: true },
//     });
//     if (!existing) return null;

//     const { tags, content, excerpt, ...rest } = input;

//     let readTimeMinutes: number | undefined;
//     let finalExcerpt: string | undefined;
//     let slug: string | undefined;
//     let publishedAt: Date | undefined;

//     if (content) {
//       const plainText = extractPlainText(content);
//       readTimeMinutes = calculateReadTime(plainText);
//       finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     }

//     if (input.title && input.title !== existing.title) {
//       slug = await uniquePostSlug(input.title, id);
//     }

//     if (input.status === "PUBLISHED" && existing.status !== PostStatus.PUBLISHED) {
//       publishedAt = new Date();
//     }

//     const post = await prisma.$transaction(async (tx) => {
//       await tx.postRevision.create({
//         data: {
//           postId: id,
//           title: existing.title,
//           content: typeof existing.content === "string"
//             ? existing.content
//             : JSON.stringify(existing.content),
//           editedBy: editorId,
//         },
//       });

//       if (tags !== undefined) {
//         await tx.postTag.deleteMany({ where: { postId: id } });
//         if (tags.length > 0) {
//           await tx.postTag.createMany({
//             data: tags.map((tagId) => ({ postId: id, tagId })),
//           });
//         }
//       }

//       return tx.post.update({
//         where: { id },
//         data: {
//           ...rest,
//           ...(content && { content: JSON.stringify(content) }),
//           ...(readTimeMinutes !== undefined && { readTimeMinutes }),
//           ...(finalExcerpt && { excerpt: finalExcerpt }),
//           ...(slug && { slug }),
//           ...(publishedAt && { publishedAt }),
//         },
//         select: { ...listSelect, content: true },
//       });
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.post(existing.slug)),
//       slug ? cacheDelete(CacheKeys.post(slug)) : Promise.resolve(),
//       cacheDeletePattern("blog:posts:*"),
//     ]);

//     if (post.status === PostStatus.PUBLISHED && publishedAt) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId: post.author.id,
//         categorySlug: post.category.slug,
//         tags: [],
//         publishedAt: publishedAt.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async delete(id: string) {
//     const post = await prisma.post.findUnique({
//       where: { id },
//       select: { slug: true },
//     });
//     if (!post) return false;

//     await prisma.post.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.post(post.slug)),
//       cacheDeletePattern("blog:posts:*"),
//     ]);
//     await publish("blog.post.deleted", { postId: id, slug: post.slug });
//     return true;
//   },

//   async recordView(postId: string, request: FastifyRequest) {
//     const ipHash = crypto.createHash("sha256").update(request.ip).digest("hex");
//     const userId = (request.user as AuthenticatedUser | undefined)?.id;
//     await incrementPostViewBuffer(postId);
//     prisma.postView.create({
//       data: {
//         postId,
//         userId,
//         ipHash,
//         userAgent: request.headers["user-agent"]?.slice(0, 200),
//         referer: request.headers.referer?.slice(0, 500),
//       },
//     }).catch(() => {});
//   },

//   async toggleReaction(postId: string, userId: string, type: "LIKE" | "BOOKMARK" | "SHARE") {
//     const existing = await prisma.postReaction.findUnique({
//       where: { postId_userId_type: { postId, userId, type } },
//     });
//     const counterField = ({ LIKE: "likeCount", BOOKMARK: "bookmarkCount", SHARE: "shareCount" } as const)[type];

//     if (existing) {
//       await prisma.$transaction([
//         prisma.postReaction.delete({ where: { postId_userId_type: { postId, userId, type } } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { decrement: 1 } } }),
//       ]);
//       return { active: false };
//     } else {
//       await prisma.$transaction([
//         prisma.postReaction.create({ data: { postId, userId, type } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { increment: 1 } } }),
//       ]);
//       return { active: true };
//     }
//   },

//   async getRelated(postId: string, limit = 4) {
//     const post = await prisma.post.findUnique({
//       where: { id: postId },
//       select: { categoryId: true, tags: { select: { tagId: true } } },
//     });
//     if (!post) return [];

//     const tagIds = post.tags.map((t) => t.tagId);
//     const raws = await prisma.post.findMany({
//       where: {
//         id: { not: postId },
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//         OR: [
//           { categoryId: post.categoryId },
//           { tags: { some: { tagId: { in: tagIds } } } },
//         ],
//       },
//       select: listSelect,
//       orderBy: { publishedAt: "desc" },
//       take: limit,
//     });
//     return raws.map(shapePostSummary);
//   },

//   async getRevisions(postId: string) {
//     return prisma.postRevision.findMany({
//       where: { postId },
//       orderBy: { createdAt: "desc" },
//       take: 20,
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listPosts(request: FastifyRequest, reply: FastifyReply) {
//   const query = ListPostsQuerySchema.parse(request.query);
//   const result = await PostsService.list(query, request.user?.id);
//   return reply.send({ success: true, ...result });
// }

// async function getPost(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const post = await PostsService.getBySlug(request.params.slug);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   PostsService.recordView((post as { id: string }).id, request).catch(() => {});
//   return reply.send({ success: true, data: post });
// }

// async function createPost(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreatePostSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.create(input, authorId);
//   return reply.code(201).send({ success: true, data: post });
// }

// async function updatePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePostSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.update(request.params.id, input, editorId);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.send({ success: true, data: post });
// }

// async function deletePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const deleted = await PostsService.delete(request.params.id);
//   if (!deleted) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.code(204).send();
// }

// async function toggleReaction(
//   request: FastifyRequest<{ Params: { id: string }; Body: { type: string } }>,
//   reply: FastifyReply
// ) {
//   const { type } = z.object({ type: z.enum(["LIKE", "BOOKMARK", "SHARE"]) }).parse(request.body);
//   const userId = (request.user as AuthenticatedUser).id;
//   const result = await PostsService.toggleReaction(request.params.id, userId, type);
//   return reply.send({ success: true, data: result });
// }

// async function getRelatedPosts(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const posts = await PostsService.getRelated(request.params.id);
//   return reply.send({ success: true, data: posts });
// }

// async function getRevisions(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const revisions = await PostsService.getRevisions(request.params.id);
//   return reply.send({ success: true, data: revisions });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function postsRoutes(fastify: FastifyInstance) {
//   fastify.get("/posts", { preHandler: [optionalAuthenticate] }, listPosts);
//   fastify.get<{ Params: { slug: string } }>("/posts/:slug", { preHandler: [optionalAuthenticate] }, getPost);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/related", getRelatedPosts);
//   fastify.post("/posts", { preHandler: [authenticate, requireEditor] }, createPost);
//   fastify.patch<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, updatePost);
//   fastify.delete<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, deletePost);
//   fastify.post<{ Params: { id: string }; Body: { type: string } }>("/posts/:id/react", { preHandler: [authenticate] }, toggleReaction);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/revisions", { preHandler: [authenticate, requireEditor] }, getRevisions);
// }



// // src/modules/posts/index.ts
// // Posts module — updated getBySlug to return the rich content format
// // matching the documented API shape with all 12 content section types.

// import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// import { z } from "zod";
// import { PostStatus } from "@prisma/client";
// import { prisma } from "../../lib/prisma";
// import { publish } from "../../lib/message-bus";
// import {
//   cacheGet, cacheSet, cacheDelete, cacheDeletePattern, incrementPostViewBuffer,
//   CacheKeys,
// } from "../../lib/redis";
// import {
//   uniquePostSlug, calculateReadTime, generateExcerpt,
// } from "../../lib/content";
// import { authenticate, optionalAuthenticate, requireEditor } from "../../middleware/auth";
// import { config } from "../../config";
// import type { AuthenticatedUser, PostPublishedPayload } from "../../types";
// import crypto from "crypto";

// // ─────────────────────────────────────────────────────────────────────
// // Content section schema (Zod)
// // Validates the JSON stored in the `content` DB column.
// // ─────────────────────────────────────────────────────────────────────

// const ParagraphSectionSchema = z.object({
//   type: z.literal("paragraph"),
//   content: z.string(),
// });

// const ParagraphWithLinksSectionSchema = z.object({
//   type: z.literal("paragraphWithLinks"),
//   contentHtml: z.string(),
// });

// const HeadingSectionSchema = z.object({
//   type: z.literal("heading"),
//   content: z.string(),
// });

// const SubheadingSectionSchema = z.object({
//   type: z.literal("subheading"),
//   content: z.string(),
// });

// const QuoteSectionSchema = z.object({
//   type: z.literal("quote"),
//   content: z.string(),
// });

// const TipSectionSchema = z.object({
//   type: z.literal("tip"),
//   content: z.string(),
// });

// const ListSectionSchema = z.object({
//   type: z.literal("list"),
//   items: z.array(z.string()),
// });

// const NumberedListSectionSchema = z.object({
//   type: z.literal("numberedList"),
//   items: z.array(z.string()),
// });

// const TwoColumnListSectionSchema = z.object({
//   type: z.literal("twoColumnList"),
//   leftColumnTitle: z.string(),
//   leftColumnItems: z.array(z.string()),
//   rightColumnTitle: z.string(),
//   rightColumnItems: z.array(z.string()),
// });

// const ImageSectionSchema = z.object({
//   type: z.literal("image"),
//   imageUrl: z.string(),
//   altText: z.string(),
//   caption: z.string().optional(),
//   width: z.number().optional(),
//   height: z.number().optional(),
// });

// const VideoSectionSchema = z.object({
//   type: z.literal("video"),
//   videoType: z.enum(["youtube", "native"]),
//   videoId: z.string().optional(),
//   videoUrl: z.string().optional(),
//   videoTitle: z.string(),
//   caption: z.string().optional(),
//   thumbnailUrl: z.string().optional(),
// });

// const TableSectionSchema = z.object({
//   type: z.literal("table"),
//   tableHeaders: z.array(z.string()),
//   tableRows: z.array(z.array(z.string())),
//   tableCaption: z.string().optional(),
// });

// const CodeSectionSchema = z.object({
//   type: z.literal("code"),
//   code: z.string(),
//   codeLanguage: z.string().optional(),
// });

// const CtaSectionSchema = z.object({
//   type: z.literal("cta"),
//   ctaTitle: z.string(),
//   ctaDescription: z.string(),
//   ctaButtonText: z.string(),
//   ctaLink: z.string(),
//   ctaNewTab: z.boolean().optional(),
// });

// const DividerSectionSchema = z.object({
//   type: z.literal("divider"),
// });

// const BlogContentSectionSchema = z.discriminatedUnion("type", [
//   ParagraphSectionSchema,
//   ParagraphWithLinksSectionSchema,
//   HeadingSectionSchema,
//   SubheadingSectionSchema,
//   QuoteSectionSchema,
//   TipSectionSchema,
//   ListSectionSchema,
//   NumberedListSectionSchema,
//   TwoColumnListSectionSchema,
//   ImageSectionSchema,
//   VideoSectionSchema,
//   TableSectionSchema,
//   CodeSectionSchema,
//   CtaSectionSchema,
//   DividerSectionSchema,
// ]);

// const ContentArraySchema = z.array(BlogContentSectionSchema);

// // ─────────────────────────────────────────────────────────────────────
// // Request schemas
// // ─────────────────────────────────────────────────────────────────────

// const CreatePostSchema = z.object({
//   title: z.string().min(5).max(200),
//   excerpt: z.string().max(500).optional(),
//   content: z.array(BlogContentSectionSchema).min(1),  // rich content array
//   categoryId: z.string().cuid("Invalid category ID"),
//   tags: z.array(z.string().cuid()).max(10).default([]),
//   coverEmoji: z.string().max(4).optional(),
//   coverGradient: z.string().max(100).optional(),
//   featured: z.boolean().default(false),
//   status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED"]).default("DRAFT"),
//   scheduledAt: z.string().datetime().optional(),
//   seoTitle: z.string().max(70).optional(),
//   seoDescription: z.string().max(160).optional(),
//   readTime: z.string().optional(),      // e.g. "6 min read" — auto-calculated if omitted
//   views: z.string().optional(),         // e.g. "0" — starts at 0
// });

// const UpdatePostSchema = CreatePostSchema.partial();

// const ListPostsQuerySchema = z.object({
//   page:      z.coerce.number().int().min(1).default(1),
//   limit:     z.coerce.number().int().min(1).max(50).default(12),
//   category:  z.string().optional(),
//   tag:       z.string().optional(),
//   author:    z.string().optional(),
//   status:    z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
//   featured:  z.coerce.boolean().optional(),
//   search:    z.string().max(200).optional(),
//   sortBy:    z.enum(["publishedAt", "likeCount", "viewCount", "createdAt"]).default("publishedAt"),
//   sortOrder: z.enum(["asc", "desc"]).default("desc"),
// });

// type CreatePostInput = z.infer<typeof CreatePostSchema>;
// type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
// type ListPostsQuery  = z.infer<typeof ListPostsQuerySchema>;

// // ─────────────────────────────────────────────────────────────────────
// // Category colour map — injected into responses so frontend is data-driven
// // ─────────────────────────────────────────────────────────────────────

// const CATEGORY_COLOURS: Record<string, { color: string; bg: string }> = {
//   "exam-prep":          { color: "text-blue-700 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950" },
//   "earn-grow":          { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950" },
//   "scholarships":       { color: "text-rose-700 dark:text-rose-400",    bg: "bg-rose-50 dark:bg-rose-950" },
//   "study-tips":         { color: "text-violet-700 dark:text-violet-400", bg: "bg-violet-50 dark:bg-violet-950" },
//   "ai-tech":            { color: "text-cyan-700 dark:text-cyan-400",    bg: "bg-cyan-50 dark:bg-cyan-950" },
//   "remote-jobs":        { color: "text-orange-700 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950" },
//   "exam-results":       { color: "text-green-700 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950" },
//   "postgraduate-guide": { color: "text-purple-700 dark:text-purple-400", bg: "bg-purple-50 dark:bg-purple-950" },
// };

// function getCategoryColours(slug: string) {
//   return (
//     CATEGORY_COLOURS[slug] ?? {
//       color: "text-blue-700 dark:text-blue-400",
//       bg: "bg-blue-50 dark:bg-blue-950",
//     }
//   );
// }

// // ─────────────────────────────────────────────────────────────────────
// // Extract plain text from content array for excerpt/readtime calculation
// // ─────────────────────────────────────────────────────────────────────

// function extractPlainText(content: z.infer<typeof ContentArraySchema>): string {
//   return content
//     .map((section) => {
//       switch (section.type) {
//         case "paragraph":
//         case "heading":
//         case "subheading":
//         case "quote":
//         case "tip":
//           return section.content;
//         case "paragraphWithLinks":
//           // Strip HTML tags for plain text
//           return section.contentHtml.replace(/<[^>]+>/g, " ");
//         case "list":
//         case "numberedList":
//           return section.items.join(" ");
//         case "twoColumnList":
//           return [
//             ...section.leftColumnItems,
//             ...section.rightColumnItems,
//           ].join(" ");
//         case "table":
//           return section.tableRows.flat().join(" ");
//         case "code":
//           return section.code;
//         default:
//           return "";
//       }
//     })
//     .filter(Boolean)
//     .join(" ");
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format view count
// // ─────────────────────────────────────────────────────────────────────

// function formatViews(n: number): string {
//   if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
//   if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
//   return String(n);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Format published date for display
// // ─────────────────────────────────────────────────────────────────────

// function formatPublishedAt(date: Date | null): string {
//   if (!date) return "";
//   return date.toLocaleDateString("en-NG", {
//     year: "numeric",
//     month: "long",
//     day: "numeric",
//   });
// }

// // ─────────────────────────────────────────────────────────────────────
// // DB select (shared between list and detail — detail adds content)
// // ─────────────────────────────────────────────────────────────────────

// const listSelect = {
//   id: true,
//   slug: true,
//   title: true,
//   excerpt: true,
//   coverEmoji: true,
//   coverImageUrl: true,
//   coverGradient: true,
//   featured: true,
//   status: true,
//   readTimeMinutes: true,
//   seoTitle: true,
//   seoDescription: true,
//   publishedAt: true,
//   viewCount: true,
//   likeCount: true,
//   commentCount: true,
//   shareCount: true,
//   bookmarkCount: true,
//   createdAt: true,
//   updatedAt: true,
//   author: {
//     select: {
//       id: true,
//       displayName: true,
//       avatarUrl: true,
//       role: true,
//       school: true,
//       verified: true,
//       bio: true,
//       twitterHandle: true,
//     },
//   },
//   category: {
//     select: {
//       id: true,
//       slug: true,
//       name: true,
//       emoji: true,
//       coverGradient: true,
//     },
//   },
//   tags: {
//     select: { tag: { select: { id: true, slug: true, name: true } } },
//   },
// } as const;

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST DETAIL
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostDetail(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   const contentSections: z.infer<typeof ContentArraySchema> = (() => {
//     try {
//       const parsed = typeof raw.content === "string"
//         ? JSON.parse(raw.content)
//         : raw.content;
//       return ContentArraySchema.parse(parsed);
//     } catch {
//       // Fallback: return a single paragraph with any existing excerpt
//       return [{ type: "paragraph" as const, content: raw.excerpt ?? "" }];
//     }
//   })();

//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     seoTitle: raw.seoTitle ?? undefined,
//     seoDescription: raw.seoDescription ?? undefined,
//     excerpt: raw.excerpt,

//     // Flat category fields
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,

//     // Cover
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",

//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),

//     // Reading meta
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,

//     // Dates
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),

//     // Author — mapped to document format
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: "from-blue-600 to-indigo-600",  // default; can be stored in author table
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },

//     // Rich content array
//     content: contentSections,
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Shape a DB row into the documented API response for POST SUMMARY
// // ─────────────────────────────────────────────────────────────────────

// // eslint-disable-next-line @typescript-eslint/no-explicit-any
// function shapePostSummary(raw: any) {
//   const colours = getCategoryColours(raw.category.slug);
//   return {
//     id: raw.id,
//     slug: raw.slug,
//     title: raw.title,
//     excerpt: raw.excerpt,
//     category: raw.category.name,
//     categorySlug: raw.category.slug,
//     categoryColor: colours.color,
//     categoryBg: colours.bg,
//     coverGradient: raw.coverGradient ?? "from-blue-600 to-indigo-700",
//     coverEmoji: raw.coverEmoji ?? "📝",
//     featured: raw.featured,
//     tags: (raw.tags as Array<{ tag: { name: string } }>).map((pt) => pt.tag.name),
//     readTime: `${raw.readTimeMinutes} min read`,
//     views: formatViews(raw.viewCount),
//     likes: raw.likeCount,
//     publishedAt: raw.publishedAt?.toISOString() ?? null,
//     publishedAtDisplay: formatPublishedAt(raw.publishedAt),
//     author: {
//       name: raw.author.displayName,
//       role: raw.author.role ?? "",
//       school: raw.author.school ?? "",
//       avatar: raw.author.displayName
//         .split(" ")
//         .map((w: string) => w[0])
//         .join("")
//         .slice(0, 2)
//         .toUpperCase(),
//       gradient: "from-blue-600 to-indigo-600",
//       bio: raw.author.bio ?? "",
//       twitter: raw.author.twitterHandle ?? undefined,
//     },
//   };
// }

// // ─────────────────────────────────────────────────────────────────────
// // Service
// // ─────────────────────────────────────────────────────────────────────

// export const PostsService = {
//   async list(query: ListPostsQuery, viewerId?: string) {
//     const cacheKey = CacheKeys.posts(JSON.stringify({ query, viewerId: undefined }));
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const where: Record<string, unknown> = {};

//     if (!viewerId || query.status === undefined) {
//       where["status"] = PostStatus.PUBLISHED;
//       where["publishedAt"] = { lte: new Date() };
//     } else if (query.status) {
//       where["status"] = PostStatus[query.status as keyof typeof PostStatus];
//     }

//     if (query.category) where["category"] = { slug: query.category };
//     if (query.tag)      where["tags"] = { some: { tag: { slug: query.tag } } };
//     if (query.author)   where["authorId"] = query.author;
//     if (query.featured !== undefined) where["featured"] = query.featured;
//     if (query.search) {
//       where["OR"] = [
//         { title:   { contains: query.search, mode: "insensitive" } },
//         { excerpt: { contains: query.search, mode: "insensitive" } },
//       ];
//     }

//     const [total, posts] = await Promise.all([
//       prisma.post.count({ where }),
//       prisma.post.findMany({
//         where,
//         select: listSelect,
//         orderBy: { [query.sortBy]: query.sortOrder },
//         skip: (query.page - 1) * query.limit,
//         take: query.limit,
//       }),
//     ]);

//     const totalPages = Math.ceil(total / query.limit);
//     const result = {
//       data: posts.map(shapePostSummary),
//       pagination: {
//         total,
//         page: query.page,
//         limit: query.limit,
//         totalPages,
//         hasNext: query.page < totalPages,
//         hasPrev: query.page > 1,
//       },
//     };

//     if (!viewerId) {
//       await cacheSet(cacheKey, result, config.CACHE_TTL_POSTS);
//     }
//     return result;
//   },

//   // ── getBySlug — returns the full rich content shape ──────────────

//   async getBySlug(slug: string) {
//     const cacheKey = CacheKeys.post(slug);
//     const cached = await cacheGet(cacheKey);
//     if (cached) return cached;

//     const raw = await prisma.post.findFirst({
//       where: {
//         slug,
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//       },
//       select: {
//         ...listSelect,
//         content: true,   // raw JSON stored in DB
//       },
//     });

//     if (!raw) return null;

//     const shaped = shapePostDetail(raw);
//     await cacheSet(cacheKey, shaped, config.CACHE_TTL_POST);
//     return shaped;
//   },

//   // ── getById (editor use — bypasses PUBLISHED filter) ─────────────

//   async getById(id: string) {
//     const raw = await prisma.post.findUnique({
//       where: { id },
//       select: { ...listSelect, content: true, scheduledAt: true },
//     });
//     if (!raw) return null;
//     return shapePostDetail(raw);
//   },

//   async create(input: CreatePostInput, authorId: string) {
//     const { tags, content, excerpt, ...rest } = input;

//     const slug = await uniquePostSlug(input.title);
//     const plainText = extractPlainText(content);
//     const readTimeMinutes = calculateReadTime(plainText);
//     const finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     const publishedAt = input.status === "PUBLISHED" ? new Date()
//       : input.scheduledAt ? new Date(input.scheduledAt) : null;

//     const post = await prisma.post.create({
//       data: {
//         ...rest,
//         slug,
//         content: JSON.stringify(content),  // stored as JSON string in DB
//         excerpt: finalExcerpt,
//         readTimeMinutes,
//         authorId,
//         publishedAt,
//         scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
//         tags: {
//           create: tags.map((tagId) => ({ tag: { connect: { id: tagId } } })),
//         },
//       },
//       select: { ...listSelect, content: true },
//     });

//     if (post.status === PostStatus.PUBLISHED) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId,
//         categorySlug: post.category.slug,
//         tags: (post.tags as Array<{ tag: { slug: string } }>).map((pt) => pt.tag.slug),
//         publishedAt: post.publishedAt!.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async update(id: string, input: UpdatePostInput, editorId: string) {
//     const existing = await prisma.post.findUnique({
//       where: { id },
//       select: { title: true, content: true, slug: true, status: true },
//     });
//     if (!existing) return null;

//     const { tags, content, excerpt, ...rest } = input;

//     let readTimeMinutes: number | undefined;
//     let finalExcerpt: string | undefined;
//     let slug: string | undefined;
//     let publishedAt: Date | undefined;

//     if (content) {
//       const plainText = extractPlainText(content);
//       readTimeMinutes = calculateReadTime(plainText);
//       finalExcerpt = excerpt ?? generateExcerpt(plainText);
//     }

//     if (input.title && input.title !== existing.title) {
//       slug = await uniquePostSlug(input.title, id);
//     }

//     if (input.status === "PUBLISHED" && existing.status !== PostStatus.PUBLISHED) {
//       publishedAt = new Date();
//     }

//     const post = await prisma.$transaction(async (tx) => {
//       await tx.postRevision.create({
//         data: {
//           postId: id,
//           title: existing.title,
//           content: typeof existing.content === "string"
//             ? existing.content
//             : JSON.stringify(existing.content),
//           editedBy: editorId,
//         },
//       });

//       if (tags !== undefined) {
//         await tx.postTag.deleteMany({ where: { postId: id } });
//         if (tags.length > 0) {
//           await tx.postTag.createMany({
//             data: tags.map((tagId) => ({ postId: id, tagId })),
//           });
//         }
//       }

//       return tx.post.update({
//         where: { id },
//         data: {
//           ...rest,
//           ...(content && { content: JSON.stringify(content) }),
//           ...(readTimeMinutes !== undefined && { readTimeMinutes }),
//           ...(finalExcerpt && { excerpt: finalExcerpt }),
//           ...(slug && { slug }),
//           ...(publishedAt && { publishedAt }),
//         },
//         select: { ...listSelect, content: true },
//       });
//     });

//     await Promise.all([
//       cacheDelete(CacheKeys.post(existing.slug)),
//       slug ? cacheDelete(CacheKeys.post(slug)) : Promise.resolve(),
//       cacheDeletePattern("blog:posts:*"),
//     ]);

//     if (post.status === PostStatus.PUBLISHED && publishedAt) {
//       await publish<PostPublishedPayload>("blog.post.published", {
//         postId: post.id,
//         slug: post.slug,
//         title: post.title,
//         authorId: post.author.id,
//         categorySlug: post.category.slug,
//         tags: [],
//         publishedAt: publishedAt.toISOString(),
//       });
//     }

//     return shapePostDetail(post);
//   },

//   async delete(id: string) {
//     const post = await prisma.post.findUnique({
//       where: { id },
//       select: { slug: true },
//     });
//     if (!post) return false;

//     await prisma.post.delete({ where: { id } });
//     await Promise.all([
//       cacheDelete(CacheKeys.post(post.slug)),
//       cacheDeletePattern("blog:posts:*"),
//     ]);
//     await publish("blog.post.deleted", { postId: id, slug: post.slug });
//     return true;
//   },

//   async recordView(postId: string, request: FastifyRequest) {
//     const ipHash = crypto.createHash("sha256").update(request.ip).digest("hex");
//     const userId = (request.user as AuthenticatedUser | undefined)?.id;
//     await incrementPostViewBuffer(postId);
//     prisma.postView.create({
//       data: {
//         postId,
//         userId,
//         ipHash,
//         userAgent: request.headers["user-agent"]?.slice(0, 200),
//         referer: request.headers.referer?.slice(0, 500),
//       },
//     }).catch(() => {});
//   },

//   async toggleReaction(postId: string, userId: string, type: "LIKE" | "BOOKMARK" | "SHARE") {
//     const existing = await prisma.postReaction.findUnique({
//       where: { postId_userId_type: { postId, userId, type } },
//     });
//     const counterField = ({ LIKE: "likeCount", BOOKMARK: "bookmarkCount", SHARE: "shareCount" } as const)[type];

//     if (existing) {
//       await prisma.$transaction([
//         prisma.postReaction.delete({ where: { postId_userId_type: { postId, userId, type } } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { decrement: 1 } } }),
//       ]);
//       return { active: false };
//     } else {
//       await prisma.$transaction([
//         prisma.postReaction.create({ data: { postId, userId, type } }),
//         prisma.post.update({ where: { id: postId }, data: { [counterField]: { increment: 1 } } }),
//       ]);
//       return { active: true };
//     }
//   },

//   async getRelated(postId: string, limit = 4) {
//     const post = await prisma.post.findUnique({
//       where: { id: postId },
//       select: { categoryId: true, tags: { select: { tagId: true } } },
//     });
//     if (!post) return [];

//     const tagIds = post.tags.map((t) => t.tagId);
//     const raws = await prisma.post.findMany({
//       where: {
//         id: { not: postId },
//         status: PostStatus.PUBLISHED,
//         publishedAt: { lte: new Date() },
//         OR: [
//           { categoryId: post.categoryId },
//           { tags: { some: { tagId: { in: tagIds } } } },
//         ],
//       },
//       select: listSelect,
//       orderBy: { publishedAt: "desc" },
//       take: limit,
//     });
//     return raws.map(shapePostSummary);
//   },

//   async getRevisions(postId: string) {
//     return prisma.postRevision.findMany({
//       where: { postId },
//       orderBy: { createdAt: "desc" },
//       take: 20,
//     });
//   },
// };

// // ─────────────────────────────────────────────────────────────────────
// // Route handlers
// // ─────────────────────────────────────────────────────────────────────

// async function listPosts(request: FastifyRequest, reply: FastifyReply) {
//   const query = ListPostsQuerySchema.parse(request.query);
//   const result = await PostsService.list(query, request.user?.id);
//   return reply.send({ success: true, ...result });
// }

// async function getPost(
//   request: FastifyRequest<{ Params: { slug: string } }>,
//   reply: FastifyReply
// ) {
//   const post = await PostsService.getBySlug(request.params.slug);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   PostsService.recordView((post as { id: string }).id, request).catch(() => {});
//   return reply.send({ success: true, data: post });
// }

// async function createPost(request: FastifyRequest, reply: FastifyReply) {
//   const input = CreatePostSchema.parse(request.body);
//   const authorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.create(input, authorId);
//   return reply.code(201).send({ success: true, data: post });
// }

// async function updatePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const input = UpdatePostSchema.parse(request.body);
//   const editorId = (request.user as AuthenticatedUser).id;
//   const post = await PostsService.update(request.params.id, input, editorId);
//   if (!post) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.send({ success: true, data: post });
// }

// async function deletePost(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const deleted = await PostsService.delete(request.params.id);
//   if (!deleted) {
//     return reply.code(404).send({
//       success: false,
//       error: { code: "NOT_FOUND", message: "Post not found" },
//     });
//   }
//   return reply.code(204).send();
// }

// async function toggleReaction(
//   request: FastifyRequest<{ Params: { id: string }; Body: { type: string } }>,
//   reply: FastifyReply
// ) {
//   const { type } = z.object({ type: z.enum(["LIKE", "BOOKMARK", "SHARE"]) }).parse(request.body);
//   const userId = (request.user as AuthenticatedUser).id;
//   const result = await PostsService.toggleReaction(request.params.id, userId, type);
//   return reply.send({ success: true, data: result });
// }

// async function getRelatedPosts(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const posts = await PostsService.getRelated(request.params.id);
//   return reply.send({ success: true, data: posts });
// }

// async function getRevisions(
//   request: FastifyRequest<{ Params: { id: string } }>,
//   reply: FastifyReply
// ) {
//   const revisions = await PostsService.getRevisions(request.params.id);
//   return reply.send({ success: true, data: revisions });
// }

// // ─────────────────────────────────────────────────────────────────────
// // Plugin registration
// // ─────────────────────────────────────────────────────────────────────

// export async function postsRoutes(fastify: FastifyInstance) {
//   fastify.get("/posts", { preHandler: [optionalAuthenticate] }, listPosts);
//   fastify.get<{ Params: { slug: string } }>("/posts/:slug", { preHandler: [optionalAuthenticate] }, getPost);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/related", getRelatedPosts);
//   fastify.post("/posts", { preHandler: [authenticate, requireEditor] }, createPost);
//   fastify.patch<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, updatePost);
//   fastify.delete<{ Params: { id: string } }>("/posts/:id", { preHandler: [authenticate, requireEditor] }, deletePost);
//   fastify.post<{ Params: { id: string }; Body: { type: string } }>("/posts/:id/react", { preHandler: [authenticate] }, toggleReaction);
//   fastify.get<{ Params: { id: string } }>("/posts/:id/revisions", { preHandler: [authenticate, requireEditor] }, getRevisions);
// }




// // // src/modules/posts/index.ts
// // // Complete posts module:
// // //   Schemas → Service (business logic + DB) → Routes (HTTP handlers)

// // import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
// // import { z } from "zod";
// // import { PostStatus } from "@prisma/client";
// // import { prisma } from "../../lib/prisma";
// // import { publish } from "../../lib/message-bus";
// // import {
// //   cacheGet, cacheSet, cacheDelete, cacheDeletePattern, incrementPostViewBuffer,
// //   CacheKeys,
// // } from "../../lib/redis";
// // import {
// //   uniquePostSlug, renderMarkdown, calculateReadTime, generateExcerpt,
// // } from "../../lib/content";
// // import { authenticate, optionalAuthenticate, requireEditor } from "../../middleware/auth";
// // import { config } from "../../config";
// // import type { AuthenticatedUser, PaginatedResponse, PostPublishedPayload } from "../../types";
// // import crypto from "crypto";

// // // ─────────────────────────────────────────────────────────────────────
// // // Schemas
// // // ─────────────────────────────────────────────────────────────────────

// // const CreatePostSchema = z.object({
// //   title: z.string().min(5).max(200),
// //   content: z.string().min(100).max(50_000),
// //   excerpt: z.string().max(500).optional(),
// //   categoryId: z.string().cuid("Invalid category ID"),
// //   tags: z.array(z.string().cuid()).max(10).default([]),
// //   coverEmoji: z.string().max(4).optional(),
// //   coverGradient: z.string().max(100).optional(),
// //   featured: z.boolean().default(false),
// //   status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED"]).default("DRAFT"),
// //   scheduledAt: z.string().datetime().optional(),
// //   seoTitle: z.string().max(70).optional(),
// //   seoDescription: z.string().max(160).optional(),
// // });

// // const UpdatePostSchema = CreatePostSchema.partial();

// // const ListPostsQuerySchema = z.object({
// //   page:       z.coerce.number().int().min(1).default(1),
// //   limit:      z.coerce.number().int().min(1).max(50).default(12),
// //   category:   z.string().optional(),
// //   tag:        z.string().optional(),
// //   author:     z.string().optional(),
// //   status:     z.enum(["DRAFT", "REVIEW", "PUBLISHED", "SCHEDULED", "ARCHIVED"]).optional(),
// //   featured:   z.coerce.boolean().optional(),
// //   search:     z.string().max(200).optional(),
// //   sortBy:     z.enum(["publishedAt", "likeCount", "viewCount", "createdAt"]).default("publishedAt"),
// //   sortOrder:  z.enum(["asc", "desc"]).default("desc"),
// // });

// // type CreatePostInput = z.infer<typeof CreatePostSchema>;
// // type UpdatePostInput = z.infer<typeof UpdatePostSchema>;
// // type ListPostsQuery  = z.infer<typeof ListPostsQuerySchema>;

// // // ─────────────────────────────────────────────────────────────────────
// // // Service — pure business logic, no HTTP concerns
// // // ─────────────────────────────────────────────────────────────────────

// // const postSelect = {
// //   id: true,
// //   slug: true,
// //   title: true,
// //   excerpt: true,
// //   coverEmoji: true,
// //   coverImageUrl: true,
// //   coverGradient: true,
// //   featured: true,
// //   status: true,
// //   readTimeMinutes: true,
// //   seoTitle: true,
// //   seoDescription: true,
// //   publishedAt: true,
// //   viewCount: true,
// //   likeCount: true,
// //   commentCount: true,
// //   shareCount: true,
// //   bookmarkCount: true,
// //   createdAt: true,
// //   updatedAt: true,
// //   author: {
// //     select: {
// //       id: true, displayName: true, avatarUrl: true,
// //       role: true, school: true, verified: true,
// //     },
// //   },
// //   category: {
// //     select: { id: true, slug: true, name: true, emoji: true, coverGradient: true },
// //   },
// //   tags: {
// //     select: { tag: { select: { id: true, slug: true, name: true } } },
// //   },
// // } as const;

// // function normalisePost(raw: Record<string, unknown>) {
// //   return {
// //     ...raw,
// //     tags: (raw.tags as Array<{ tag: unknown }>).map((pt) => pt.tag),
// //   };
// // }

// // export const PostsService = {
// //   async list(query: ListPostsQuery, viewerId?: string) {
// //     const cacheKey = CacheKeys.posts(JSON.stringify({ query, viewerId: undefined }));
// //     const cached = await cacheGet(cacheKey);
// //     if (cached) return cached as PaginatedResponse<unknown>;

// //     const where: Record<string, unknown> = {};

// //     // Public consumers only see published posts
// //     if (!viewerId || query.status === undefined) {
// //       where["status"] = PostStatus.PUBLISHED;
// //       where["publishedAt"] = { lte: new Date() };
// //     } else if (query.status) {
// //       where["status"] = PostStatus[query.status as keyof typeof PostStatus];
// //     }

// //     if (query.category) {
// //       where["category"] = { slug: query.category };
// //     }
// //     if (query.tag) {
// //       where["tags"] = { some: { tag: { slug: query.tag } } };
// //     }
// //     if (query.author) {
// //       where["authorId"] = query.author;
// //     }
// //     if (query.featured !== undefined) {
// //       where["featured"] = query.featured;
// //     }
// //     if (query.search) {
// //       where["OR"] = [
// //         { title: { contains: query.search, mode: "insensitive" } },
// //         { excerpt: { contains: query.search, mode: "insensitive" } },
// //       ];
// //     }

// //     const [total, posts] = await Promise.all([
// //       prisma.post.count({ where }),
// //       prisma.post.findMany({
// //         where,
// //         select: postSelect,
// //         orderBy: { [query.sortBy]: query.sortOrder },
// //         skip: (query.page - 1) * query.limit,
// //         take: query.limit,
// //       }),
// //     ]);

// //     const totalPages = Math.ceil(total / query.limit);
// //     const result: PaginatedResponse<unknown> = {
// //       data: posts.map(normalisePost),
// //       pagination: {
// //         total,
// //         page: query.page,
// //         limit: query.limit,
// //         totalPages,
// //         hasNext: query.page < totalPages,
// //         hasPrev: query.page > 1,
// //       },
// //     };

// //     // Only cache public queries
// //     if (!viewerId) {
// //       await cacheSet(cacheKey, result, config.CACHE_TTL_POSTS);
// //     }

// //     return result;
// //   },

// //   async getBySlug(slug: string) {
// //     const cached = await cacheGet(CacheKeys.post(slug));
// //     if (cached) return cached;

// //     const post = await prisma.post.findFirst({
// //       where: {
// //         slug,
// //         status: PostStatus.PUBLISHED,
// //         publishedAt: { lte: new Date() },
// //       },
// //       select: { ...postSelect, contentHtml: true },
// //     });

// //     if (!post) return null;

// //     const normalised = normalisePost(post as unknown as Record<string, unknown>);
// //     await cacheSet(CacheKeys.post(slug), normalised, config.CACHE_TTL_POST);
// //     return normalised;
// //   },

// //   async getById(id: string) {
// //     return prisma.post.findUnique({
// //       where: { id },
// //       select: { ...postSelect, content: true, contentHtml: true, scheduledAt: true },
// //     });
// //   },

// //   async create(input: CreatePostInput, authorId: string) {
// //     const { tags, content, excerpt, ...rest } = input;

// //     const [slug, contentHtml] = await Promise.all([
// //       uniquePostSlug(input.title),
// //       renderMarkdown(content),
// //     ]);

// //     const readTimeMinutes = calculateReadTime(content);
// //     const finalExcerpt = excerpt ?? generateExcerpt(content);
// //     const publishedAt = input.status === "PUBLISHED" ? new Date() :
// //                         input.scheduledAt ? new Date(input.scheduledAt) : null;

// //     const post = await prisma.post.create({
// //       data: {
// //         ...rest,
// //         slug,
// //         content,
// //         contentHtml,
// //         excerpt: finalExcerpt,
// //         readTimeMinutes,
// //         authorId,
// //         publishedAt,
// //         scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
// //         tags: {
// //           create: tags.map((tagId) => ({ tag: { connect: { id: tagId } } })),
// //         },
// //       },
// //       select: postSelect,
// //     });

// //     // Emit event to notify other services (feed, notifications, etc.)
// //     if (post.status === PostStatus.PUBLISHED) {
// //       await publish<PostPublishedPayload>("blog.post.published", {
// //         postId: post.id,
// //         slug: post.slug,
// //         title: post.title,
// //         authorId,
// //         categorySlug: post.category.slug,
// //         tags: post.tags.map((pt) => (pt as unknown as { tag: { slug: string } }).tag.slug),
// //         publishedAt: post.publishedAt!.toISOString(),
// //       });
// //     }

// //     return normalisePost(post as unknown as Record<string, unknown>);
// //   },

// //   async update(id: string, input: UpdatePostInput, editorId: string) {
// //     const existing = await prisma.post.findUnique({
// //       where: { id },
// //       select: { title: true, content: true, slug: true, status: true },
// //     });
// //     if (!existing) return null;

// //     const { tags, content, excerpt, ...rest } = input;

// //     let contentHtml: string | undefined;
// //     let readTimeMinutes: number | undefined;
// //     let finalExcerpt: string | undefined;
// //     let slug: string | undefined;

// //     if (content) {
// //       contentHtml = await renderMarkdown(content);
// //       readTimeMinutes = calculateReadTime(content);
// //       finalExcerpt = excerpt ?? generateExcerpt(content);
// //     }

// //     if (input.title && input.title !== existing.title) {
// //       slug = await uniquePostSlug(input.title, id);
// //     }

// //     let publishedAt: Date | undefined;
// //     if (input.status === "PUBLISHED" && existing.status !== PostStatus.PUBLISHED) {
// //       publishedAt = new Date();
// //     }

// //     const post = await prisma.$transaction(async (tx) => {
// //       // Save revision before updating
// //       await tx.postRevision.create({
// //         data: {
// //           postId: id,
// //           title: existing.title,
// //           content: existing.content,
// //           editedBy: editorId,
// //         },
// //       });

// //       // Update tags if provided
// //       if (tags !== undefined) {
// //         await tx.postTag.deleteMany({ where: { postId: id } });
// //         if (tags.length > 0) {
// //           await tx.postTag.createMany({
// //             data: tags.map((tagId) => ({ postId: id, tagId })),
// //           });
// //         }
// //       }

// //       return tx.post.update({
// //         where: { id },
// //         data: {
// //           ...rest,
// //           ...(content && { content, contentHtml }),
// //           ...(readTimeMinutes !== undefined && { readTimeMinutes }),
// //           ...(finalExcerpt && { excerpt: finalExcerpt }),
// //           ...(slug && { slug }),
// //           ...(publishedAt && { publishedAt }),
// //         },
// //         select: postSelect,
// //       });
// //     });

// //     // Invalidate caches
// //     await Promise.all([
// //       cacheDelete(CacheKeys.post(existing.slug)),
// //       slug ? cacheDelete(CacheKeys.post(slug)) : Promise.resolve(),
// //       cacheDeletePattern("blog:posts:*"),
// //     ]);

// //     if (post.status === PostStatus.PUBLISHED && publishedAt) {
// //       await publish<PostPublishedPayload>("blog.post.published", {
// //         postId: post.id,
// //         slug: post.slug,
// //         title: post.title,
// //         authorId: post.author.id,
// //         categorySlug: post.category.slug,
// //         tags: [],
// //         publishedAt: publishedAt.toISOString(),
// //       });
// //     } else if (post.status === PostStatus.PUBLISHED) {
// //       await publish("blog.post.updated", { postId: id, slug: post.slug });
// //     }

// //     return normalisePost(post as unknown as Record<string, unknown>);
// //   },

// //   async delete(id: string) {
// //     const post = await prisma.post.findUnique({
// //       where: { id },
// //       select: { slug: true },
// //     });
// //     if (!post) return false;

// //     await prisma.post.delete({ where: { id } });

// //     await Promise.all([
// //       cacheDelete(CacheKeys.post(post.slug)),
// //       cacheDeletePattern("blog:posts:*"),
// //     ]);

// //     await publish("blog.post.deleted", { postId: id, slug: post.slug });
// //     return true;
// //   },

// //   async recordView(postId: string, request: FastifyRequest) {
// //     const ip = request.ip;
// //     const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
// //     const userId = (request.user as AuthenticatedUser | undefined)?.id;

// //     // Buffer views in Redis, flush to DB every 5 minutes
// //     await incrementPostViewBuffer(postId);

// //     // Log for analytics (async — fire and forget)
// //     prisma.postView.create({
// //       data: {
// //         postId,
// //         userId,
// //         ipHash,
// //         userAgent: request.headers["user-agent"]?.slice(0, 200),
// //         referer: request.headers.referer?.slice(0, 500),
// //       },
// //     }).catch(() => {}); // non-critical
// //   },

// //   async toggleReaction(
// //     postId: string,
// //     userId: string,
// //     type: "LIKE" | "BOOKMARK" | "SHARE"
// //   ) {
// //     const existing = await prisma.postReaction.findUnique({
// //       where: { postId_userId_type: { postId, userId, type } },
// //     });

// //     const counterField = {
// //       LIKE:     "likeCount",
// //       BOOKMARK: "bookmarkCount",
// //       SHARE:    "shareCount",
// //     }[type] as "likeCount" | "bookmarkCount" | "shareCount";

// //     if (existing) {
// //       await prisma.$transaction([
// //         prisma.postReaction.delete({
// //           where: { postId_userId_type: { postId, userId, type } },
// //         }),
// //         prisma.post.update({
// //           where: { id: postId },
// //           data: { [counterField]: { decrement: 1 } },
// //         }),
// //       ]);
// //       return { active: false };
// //     } else {
// //       await prisma.$transaction([
// //         prisma.postReaction.create({ data: { postId, userId, type } }),
// //         prisma.post.update({
// //           where: { id: postId },
// //           data: { [counterField]: { increment: 1 } },
// //         }),
// //       ]);
// //       return { active: true };
// //     }
// //   },

// //   async getRelated(postId: string, limit = 4) {
// //     const post = await prisma.post.findUnique({
// //       where: { id: postId },
// //       select: { categoryId: true, tags: { select: { tagId: true } } },
// //     });
// //     if (!post) return [];

// //     const tagIds = post.tags.map((t) => t.tagId);

// //     return prisma.post.findMany({
// //       where: {
// //         id: { not: postId },
// //         status: PostStatus.PUBLISHED,
// //         publishedAt: { lte: new Date() },
// //         OR: [
// //           { categoryId: post.categoryId },
// //           { tags: { some: { tagId: { in: tagIds } } } },
// //         ],
// //       },
// //       select: postSelect,
// //       orderBy: { publishedAt: "desc" },
// //       take: limit,
// //     });
// //   },

// //   async getRevisions(postId: string) {
// //     return prisma.postRevision.findMany({
// //       where: { postId },
// //       orderBy: { createdAt: "desc" },
// //       take: 20,
// //     });
// //   },
// // };

// // // ─────────────────────────────────────────────────────────────────────
// // // Route handlers
// // // ─────────────────────────────────────────────────────────────────────

// // async function listPosts(request: FastifyRequest, reply: FastifyReply) {
// //   const query = ListPostsQuerySchema.parse(request.query);
// //   const result = await PostsService.list(query, request.user?.id);
// //   return reply.send({ success: true, ...result });
// // }

// // async function getPost(
// //   request: FastifyRequest<{ Params: { slug: string } }>,
// //   reply: FastifyReply
// // ) {
// //   const post = await PostsService.getBySlug(request.params.slug);
// //   if (!post) {
// //     return reply.code(404).send({
// //       success: false,
// //       error: { code: "NOT_FOUND", message: "Post not found" },
// //     });
// //   }

// //   // Fire-and-forget view tracking
// //   PostsService.recordView(
// //     (post as { id: string }).id,
// //     request
// //   ).catch(() => {});

// //   return reply.send({ success: true, data: post });
// // }

// // async function createPost(request: FastifyRequest, reply: FastifyReply) {
// //   const input = CreatePostSchema.parse(request.body);
// //   const authorId = (request.user as AuthenticatedUser).id;
// //   const post = await PostsService.create(input, authorId);
// //   return reply.code(201).send({ success: true, data: post });
// // }

// // async function updatePost(
// //   request: FastifyRequest<{ Params: { id: string } }>,
// //   reply: FastifyReply
// // ) {
// //   const input = UpdatePostSchema.parse(request.body);
// //   const editorId = (request.user as AuthenticatedUser).id;
// //   const post = await PostsService.update(request.params.id, input, editorId);
// //   if (!post) {
// //     return reply.code(404).send({
// //       success: false,
// //       error: { code: "NOT_FOUND", message: "Post not found" },
// //     });
// //   }
// //   return reply.send({ success: true, data: post });
// // }

// // async function deletePost(
// //   request: FastifyRequest<{ Params: { id: string } }>,
// //   reply: FastifyReply
// // ) {
// //   const deleted = await PostsService.delete(request.params.id);
// //   if (!deleted) {
// //     return reply.code(404).send({
// //       success: false,
// //       error: { code: "NOT_FOUND", message: "Post not found" },
// //     });
// //   }
// //   return reply.code(204).send();
// // }

// // async function toggleReaction(
// //   request: FastifyRequest<{
// //     Params: { id: string };
// //     Body: { type: "LIKE" | "BOOKMARK" | "SHARE" };
// //   }>,
// //   reply: FastifyReply
// // ) {
// //   const { type } = z.object({ type: z.enum(["LIKE", "BOOKMARK", "SHARE"]) })
// //     .parse(request.body);
// //   const userId = (request.user as AuthenticatedUser).id;
// //   const result = await PostsService.toggleReaction(request.params.id, userId, type);
// //   return reply.send({ success: true, data: result });
// // }

// // async function getRelatedPosts(
// //   request: FastifyRequest<{ Params: { id: string } }>,
// //   reply: FastifyReply
// // ) {
// //   const posts = await PostsService.getRelated(request.params.id);
// //   return reply.send({ success: true, data: posts });
// // }

// // async function getRevisions(
// //   request: FastifyRequest<{ Params: { id: string } }>,
// //   reply: FastifyReply
// // ) {
// //   const revisions = await PostsService.getRevisions(request.params.id);
// //   return reply.send({ success: true, data: revisions });
// // }

// // // ─────────────────────────────────────────────────────────────────────
// // // Plugin registration
// // // ─────────────────────────────────────────────────────────────────────

// // export async function postsRoutes(fastify: FastifyInstance) {
// //   // Public routes
// //   fastify.get("/posts", { preHandler: [optionalAuthenticate] }, listPosts);

// //   fastify.get<{ Params: { slug: string } }>(
// //     "/posts/:slug",
// //     { preHandler: [optionalAuthenticate] },
// //     getPost
// //   );

// //   fastify.get<{ Params: { id: string } }>(
// //     "/posts/:id/related",
// //     getRelatedPosts
// //   );

// //   // Authenticated routes
// //   fastify.post(
// //     "/posts",
// //     { preHandler: [authenticate, requireEditor] },
// //     createPost
// //   );

// //   fastify.patch<{ Params: { id: string } }>(
// //     "/posts/:id",
// //     { preHandler: [authenticate, requireEditor] },
// //     updatePost
// //   );

// //   fastify.delete<{ Params: { id: string } }>(
// //     "/posts/:id",
// //     { preHandler: [authenticate, requireEditor] },
// //     deletePost
// //   );

// //   fastify.post<{ Params: { id: string }; Body: { type: "LIKE" | "BOOKMARK" | "SHARE" } }>(
// //     "/posts/:id/react",
// //     { preHandler: [authenticate] },
// //     toggleReaction
// //   );

// //   fastify.get<{ Params: { id: string } }>(
// //     "/posts/:id/revisions",
// //     { preHandler: [authenticate, requireEditor] },
// //     getRevisions
// //   );
// // }