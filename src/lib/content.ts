// src/lib/content.ts
// Content processing utilities:
//   - Slug generation (unique, SEO-safe)
//   - Markdown → HTML rendering with sanitisation
//   - Reading time calculation
//   - Excerpt generation

import slugify from "slugify";
import { marked } from "marked";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import readingTime from "reading-time";
import { prisma } from "./prisma";

// Initialise DOMPurify with jsdom (for Node.js — browser not available)
const { window } = new JSDOM("");
const purify = DOMPurify(window as unknown as Window);

// ─────────────────────────────────────────────────────────────────────
// Slug generation
// ─────────────────────────────────────────────────────────────────────

export function toSlug(input: string): string {
  return slugify(input, {
    lower: true,
    strict: true,      // strip special characters
    trim: true,
    replacement: "-",
  });
}

/**
 * Generate a slug that is guaranteed to be unique in the posts table.
 * If "my-post" exists, returns "my-post-2", then "my-post-3", etc.
 */
export async function uniquePostSlug(
  title: string,
  excludeId?: string
): Promise<string> {
  const base = toSlug(title);
  let candidate = base;
  let suffix = 2;

  while (true) {
    const existing = await prisma.post.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });

    if (!existing || existing.id === excludeId) {
      return candidate;
    }

    candidate = `${base}-${suffix}`;
    suffix++;
  }
}

/**
 * Generate a unique slug for categories/tags (simpler — no numeric suffix needed).
 */
export async function uniqueCategorySlug(name: string): Promise<string> {
  const slug = toSlug(name);
  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) {
    throw new Error(`A category with slug "${slug}" already exists`);
  }
  return slug;
}

export async function uniqueTagSlug(name: string): Promise<string> {
  const slug = toSlug(name);
  const existing = await prisma.tag.findUnique({ where: { slug } });
  if (existing) {
    throw new Error(`A tag with slug "${slug}" already exists`);
  }
  return slug;
}

// ─────────────────────────────────────────────────────────────────────
// Markdown rendering
// ─────────────────────────────────────────────────────────────────────

// Configure marked for security
marked.setOptions({
  gfm: true,      // GitHub-flavoured markdown
  breaks: false,
});

// Allowed HTML tags and attributes after sanitisation
const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "strong", "em", "del", "ins", "mark", "sup", "sub",
    "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "target", "rel"],
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: false,
};

/**
 * Convert Markdown to sanitised HTML.
 * Called at write time so we store pre-rendered HTML and don't re-parse on every read.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  const rawHtml = await marked.parse(markdown);
  return purify.sanitize(rawHtml, DOMPURIFY_CONFIG);
}

// ─────────────────────────────────────────────────────────────────────
// Reading time
// ─────────────────────────────────────────────────────────────────────

export function calculateReadTime(content: string): number {
  const stats = readingTime(content);
  return Math.ceil(stats.minutes); // round up to nearest minute
}

// ─────────────────────────────────────────────────────────────────────
// Excerpt generation
// ─────────────────────────────────────────────────────────────────────

/**
 * Strip markdown and truncate to `maxChars` characters, ending on a word boundary.
 */
export function generateExcerpt(markdown: string, maxChars = 200): string {
  // Strip common markdown syntax
  const plain = markdown
    .replace(/#{1,6}\s+/g, "")          // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/\*(.+?)\*/g, "$1")        // italic
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .replace(/`{1,3}[^`]*`{1,3}/g, "")  // code
    .replace(/>\s+/g, "")               // blockquotes
    .replace(/\n+/g, " ")              // newlines
    .trim();

  if (plain.length <= maxChars) return plain;

  // Truncate at word boundary
  const truncated = plain.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated) + "…";
}



// // src/lib/content.ts
// // Content processing utilities:
// //   - Slug generation (unique, SEO-safe)
// //   - Markdown → HTML rendering with sanitisation
// //   - Reading time calculation
// //   - Excerpt generation

// import slugify from "slugify";
// import { marked } from "marked";
// import { JSDOM } from "jsdom";
// import DOMPurify from "dompurify";
// import readingTime from "reading-time";
// import { prisma } from "./prisma";

// // Initialise DOMPurify with jsdom (for Node.js — browser not available)
// const { window } = new JSDOM("");
// const purify = DOMPurify(window as unknown as Window);

// // ─────────────────────────────────────────────────────────────────────
// // Slug generation
// // ─────────────────────────────────────────────────────────────────────

// export function toSlug(input: string): string {
//   return slugify(input, {
//     lower: true,
//     strict: true,      // strip special characters
//     trim: true,
//     replacement: "-",
//   });
// }

// /**
//  * Generate a slug that is guaranteed to be unique in the posts table.
//  * If "my-post" exists, returns "my-post-2", then "my-post-3", etc.
//  */
// export async function uniquePostSlug(
//   title: string,
//   excludeId?: string
// ): Promise<string> {
//   const base = toSlug(title);
//   let candidate = base;
//   let suffix = 2;

//   while (true) {
//     const existing = await prisma.post.findUnique({
//       where: { slug: candidate },
//       select: { id: true },
//     });

//     if (!existing || existing.id === excludeId) {
//       return candidate;
//     }

//     candidate = `${base}-${suffix}`;
//     suffix++;
//   }
// }

// /**
//  * Generate a unique slug for categories/tags (simpler — no numeric suffix needed).
//  */
// export async function uniqueCategorySlug(name: string): Promise<string> {
//   const slug = toSlug(name);
//   const existing = await prisma.category.findUnique({ where: { slug } });
//   if (existing) {
//     throw new Error(`A category with slug "${slug}" already exists`);
//   }
//   return slug;
// }

// export async function uniqueTagSlug(name: string): Promise<string> {
//   const slug = toSlug(name);
//   const existing = await prisma.tag.findUnique({ where: { slug } });
//   if (existing) {
//     throw new Error(`A tag with slug "${slug}" already exists`);
//   }
//   return slug;
// }

// // ─────────────────────────────────────────────────────────────────────
// // Markdown rendering
// // ─────────────────────────────────────────────────────────────────────

// // Configure marked for security
// marked.setOptions({
//   gfm: true,      // GitHub-flavoured markdown
//   breaks: false,
// });

// // Allowed HTML tags and attributes after sanitisation
// const DOMPURIFY_CONFIG = {
//   ALLOWED_TAGS: [
//     "h1", "h2", "h3", "h4", "h5", "h6",
//     "p", "br", "hr",
//     "ul", "ol", "li",
//     "blockquote", "pre", "code",
//     "strong", "em", "del", "ins", "mark", "sup", "sub",
//     "a", "img", "figure", "figcaption",
//     "table", "thead", "tbody", "tr", "th", "td",
//   ],
//   ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "target", "rel"],
//   ALLOW_DATA_ATTR: false,
//   FORCE_BODY: false,
// };

// /**
//  * Convert Markdown to sanitised HTML.
//  * Called at write time so we store pre-rendered HTML and don't re-parse on every read.
//  */
// export async function renderMarkdown(markdown: string): Promise<string> {
//   const rawHtml = await marked.parse(markdown);
//   return purify.sanitize(rawHtml, DOMPURIFY_CONFIG);
// }

// // ─────────────────────────────────────────────────────────────────────
// // Reading time
// // ─────────────────────────────────────────────────────────────────────

// export function calculateReadTime(content: string): number {
//   const stats = readingTime(content);
//   return Math.ceil(stats.minutes); // round up to nearest minute
// }

// // ─────────────────────────────────────────────────────────────────────
// // Excerpt generation
// // ─────────────────────────────────────────────────────────────────────

// /**
//  * Strip markdown and truncate to `maxChars` characters, ending on a word boundary.
//  */
// export function generateExcerpt(markdown: string, maxChars = 200): string {
//   // Strip common markdown syntax
//   const plain = markdown
//     .replace(/#{1,6}\s+/g, "")          // headings
//     .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
//     .replace(/\*(.+?)\*/g, "$1")        // italic
//     .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
//     .replace(/`{1,3}[^`]*`{1,3}/g, "")  // code
//     .replace(/>\s+/g, "")               // blockquotes
//     .replace(/\n+/g, " ")              // newlines
//     .trim();

//   if (plain.length <= maxChars) return plain;

//   // Truncate at word boundary
//   const truncated = plain.slice(0, maxChars);
//   const lastSpace = truncated.lastIndexOf(" ");
//   return (lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated) + "…";
// }
