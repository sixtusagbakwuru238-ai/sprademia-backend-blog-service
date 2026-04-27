// prisma/seed.ts
// Seeds the database with initial categories, tags, a sample author and posts.
// Run with: npm run db:seed

import { PrismaClient, PostStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.info("🌱 Seeding database…");

  // ── Categories ──────────────────────────────────────────────────────
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { slug: "exam-prep" },
      update: {},
      create: {
        name: "Exam Prep",
        slug: "exam-prep",
        description: "In-depth guides to help you score higher in JAMB, WAEC, NECO, Post-UTME and university exams.",
        seoDescription: "Expert exam preparation guides for Nigerian students — JAMB, WAEC, NECO and university exams.",
        coverGradient: "from-blue-600 to-indigo-700",
        emoji: "📚",
        sortOrder: 1,
      },
    }),
    prisma.category.upsert({
      where: { slug: "earn-grow" },
      update: {},
      create: {
        name: "Earn & Grow",
        slug: "earn-grow",
        description: "Real, proven income streams for Nigerian students — from selling study notes to remote freelancing.",
        seoDescription: "How Nigerian students earn ₦100k+ monthly — real strategies, real numbers.",
        coverGradient: "from-emerald-500 to-teal-600",
        emoji: "💰",
        sortOrder: 2,
      },
    }),
    prisma.category.upsert({
      where: { slug: "scholarships" },
      update: {},
      create: {
        name: "Scholarships",
        slug: "scholarships",
        description: "Verified local and international scholarships, grants and bursaries open to Nigerian students.",
        seoDescription: "Up-to-date scholarship opportunities for Nigerian students in 2025.",
        coverGradient: "from-rose-500 to-pink-600",
        emoji: "🎓",
        sortOrder: 3,
      },
    }),
    prisma.category.upsert({
      where: { slug: "study-tips" },
      update: {},
      create: {
        name: "Study Tips",
        slug: "study-tips",
        description: "Science-backed study techniques, note-taking strategies and productivity habits that raise GPAs.",
        seoDescription: "Study tips for Nigerian university students — raise your CGPA with proven methods.",
        coverGradient: "from-violet-500 to-purple-700",
        emoji: "👥",
        sortOrder: 4,
      },
    }),
    prisma.category.upsert({
      where: { slug: "ai-tech" },
      update: {},
      create: {
        name: "AI & Tech",
        slug: "ai-tech",
        description: "How AI and EdTech tools are changing the way Nigerian students learn and prepare.",
        seoDescription: "AI tutoring and EdTech tools for Nigerian students — practical guides.",
        coverGradient: "from-cyan-500 to-blue-600",
        emoji: "🤖",
        sortOrder: 5,
      },
    }),
    prisma.category.upsert({
      where: { slug: "remote-jobs" },
      update: {},
      create: {
        name: "Remote Jobs",
        slug: "remote-jobs",
        description: "Flexible, student-friendly remote opportunities with real pay ranges and skill requirements.",
        seoDescription: "Best remote jobs for Nigerian students in 2025 — real pay in naira.",
        coverGradient: "from-orange-500 to-amber-600",
        emoji: "💼",
        sortOrder: 6,
      },
    }),
  ]);

  console.info(`  ✓ ${categories.length} categories seeded`);

  // ── Tags ─────────────────────────────────────────────────────────
  const tagData = [
    { name: "JAMB", slug: "jamb" },
    { name: "WAEC", slug: "waec" },
    { name: "NECO", slug: "neco" },
    { name: "UTME", slug: "utme" },
    { name: "CBT", slug: "cbt" },
    { name: "Exam Strategy", slug: "exam-strategy" },
    { name: "Study Plan", slug: "study-plan" },
    { name: "Side Hustle", slug: "side-hustle" },
    { name: "Student Income", slug: "student-income" },
    { name: "Remote Work", slug: "remote-work" },
    { name: "Content Creation", slug: "content-creation" },
    { name: "Freelancing", slug: "freelancing" },
    { name: "Study Groups", slug: "study-groups" },
    { name: "GPA", slug: "gpa" },
    { name: "Productivity", slug: "productivity" },
    { name: "AI", slug: "ai" },
    { name: "EdTech", slug: "edtech" },
    { name: "Scholarships", slug: "scholarships" },
    { name: "Funding", slug: "funding" },
    { name: "Career", slug: "career" },
  ];

  await Promise.all(
    tagData.map((t) =>
      prisma.tag.upsert({
        where: { slug: t.slug },
        update: {},
        create: t,
      })
    )
  );

  console.info(`  ✓ ${tagData.length} tags seeded`);

  // ── Sample author ─────────────────────────────────────────────────
  const author = await prisma.author.upsert({
    where: { id: "author-seed-001" },
    update: {},
    create: {
      id:          "author-seed-001",
      displayName: "StudyNation Editorial",
      bio:         "The StudyNation editorial team.",
      gradient:    "from-blue-600 to-indigo-600",
      verified:    true,
    },
  });

  console.info(`  ✓ Seed author: ${author.displayName}`);

  // ── Sample post ───────────────────────────────────────────────────
  const examPrepCategory = categories[0];
  const jambTag = await prisma.tag.findUnique({ where: { slug: "jamb" } });

  const sampleContent = JSON.stringify([
    {
      type: "paragraph",
      content: "Welcome to the StudyNation blog — your go-to resource for exam prep, scholarships, student income and everything in between.",
    },
    {
      type: "heading",
      content: "What You'll Find Here",
    },
    {
      type: "list",
      items: [
        "Expert exam guides for JAMB, WAEC, NECO and Post-UTME",
        "Verified scholarship opportunities updated weekly",
        "Realistic income strategies for Nigerian students",
        "AI tools and EdTech guides",
      ],
    },
    {
      type: "tip",
      content: "Bookmark this page and check back every Friday for fresh content written by students, for students.",
    },
  ]);

  await prisma.post.upsert({
    where: { slug: "welcome-to-studynation-blog" },
    update: {},
    create: {
      slug:           "welcome-to-studynation-blog",
      title:          "Welcome to the StudyNation Blog",
      excerpt:        "Your go-to resource for exam prep, scholarships, student income and everything in between.",
      content:        sampleContent,           // stored as JSON string
      coverEmoji:     "📚",
      coverGradient:  "from-blue-600 to-indigo-700",
      featured:       true,
      status:         PostStatus.PUBLISHED,
      publishedAt:    new Date(),
      readTimeMinutes: 2,
      authorId:       author.id,
      categoryId:     examPrepCategory.id,
      ...(jambTag && {
        tags: { create: [{ tag: { connect: { id: jambTag.id } } }] },
      }),
    },
  });

  console.info("  ✓ Sample post seeded");
  console.info("\n✅ Seeding complete");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());



// // prisma/seed.ts
// // Seeds the database with initial categories, tags, a sample author and posts.
// // Run with: npm run db:seed

// import { PrismaClient, PostStatus } from "@prisma/client";

// const prisma = new PrismaClient();

// async function main() {
//   console.info("🌱 Seeding database…");

//   // ── Categories ──────────────────────────────────────────────────────
//   const categories = await Promise.all([
//     prisma.category.upsert({
//       where: { slug: "exam-prep" },
//       update: {},
//       create: {
//         name: "Exam Prep",
//         slug: "exam-prep",
//         description: "In-depth guides to help you score higher in JAMB, WAEC, NECO, Post-UTME and university exams.",
//         seoDescription: "Expert exam preparation guides for Nigerian students — JAMB, WAEC, NECO and university exams.",
//         coverGradient: "from-blue-600 to-indigo-700",
//         emoji: "📚",
//         sortOrder: 1,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "earn-grow" },
//       update: {},
//       create: {
//         name: "Earn & Grow",
//         slug: "earn-grow",
//         description: "Real, proven income streams for Nigerian students — from selling study notes to remote freelancing.",
//         seoDescription: "How Nigerian students earn ₦100k+ monthly — real strategies, real numbers.",
//         coverGradient: "from-emerald-500 to-teal-600",
//         emoji: "💰",
//         sortOrder: 2,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "scholarships" },
//       update: {},
//       create: {
//         name: "Scholarships",
//         slug: "scholarships",
//         description: "Verified local and international scholarships, grants and bursaries open to Nigerian students.",
//         seoDescription: "Up-to-date scholarship opportunities for Nigerian students in 2025.",
//         coverGradient: "from-rose-500 to-pink-600",
//         emoji: "🎓",
//         sortOrder: 3,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "study-tips" },
//       update: {},
//       create: {
//         name: "Study Tips",
//         slug: "study-tips",
//         description: "Science-backed study techniques, note-taking strategies and productivity habits that raise GPAs.",
//         seoDescription: "Study tips for Nigerian university students — raise your CGPA with proven methods.",
//         coverGradient: "from-violet-500 to-purple-700",
//         emoji: "👥",
//         sortOrder: 4,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "ai-tech" },
//       update: {},
//       create: {
//         name: "AI & Tech",
//         slug: "ai-tech",
//         description: "How AI and EdTech tools are changing the way Nigerian students learn and prepare.",
//         seoDescription: "AI tutoring and EdTech tools for Nigerian students — practical guides.",
//         coverGradient: "from-cyan-500 to-blue-600",
//         emoji: "🤖",
//         sortOrder: 5,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "remote-jobs" },
//       update: {},
//       create: {
//         name: "Remote Jobs",
//         slug: "remote-jobs",
//         description: "Flexible, student-friendly remote opportunities with real pay ranges and skill requirements.",
//         seoDescription: "Best remote jobs for Nigerian students in 2025 — real pay in naira.",
//         coverGradient: "from-orange-500 to-amber-600",
//         emoji: "💼",
//         sortOrder: 6,
//       },
//     }),
//   ]);

//   console.info(`  ✓ ${categories.length} categories seeded`);

//   // ── Tags ─────────────────────────────────────────────────────────
//   const tagData = [
//     { name: "JAMB", slug: "jamb" },
//     { name: "WAEC", slug: "waec" },
//     { name: "NECO", slug: "neco" },
//     { name: "UTME", slug: "utme" },
//     { name: "CBT", slug: "cbt" },
//     { name: "Exam Strategy", slug: "exam-strategy" },
//     { name: "Study Plan", slug: "study-plan" },
//     { name: "Side Hustle", slug: "side-hustle" },
//     { name: "Student Income", slug: "student-income" },
//     { name: "Remote Work", slug: "remote-work" },
//     { name: "Content Creation", slug: "content-creation" },
//     { name: "Freelancing", slug: "freelancing" },
//     { name: "Study Groups", slug: "study-groups" },
//     { name: "GPA", slug: "gpa" },
//     { name: "Productivity", slug: "productivity" },
//     { name: "AI", slug: "ai" },
//     { name: "EdTech", slug: "edtech" },
//     { name: "Scholarships", slug: "scholarships" },
//     { name: "Funding", slug: "funding" },
//     { name: "Career", slug: "career" },
//   ];

//   await Promise.all(
//     tagData.map((t) =>
//       prisma.tag.upsert({
//         where: { slug: t.slug },
//         update: {},
//         create: t,
//       })
//     )
//   );

//   console.info(`  ✓ ${tagData.length} tags seeded`);

//   // ── Sample author ─────────────────────────────────────────────────
//   const author = await prisma.author.upsert({
//     where: { id: "author-seed-001" },
//     update: {},
//     create: {
//       id:          "author-seed-001",
//       displayName: "StudyNation Editorial",
//       bio:         "The StudyNation editorial team.",
//       gradient:    "from-blue-600 to-indigo-600",
//       verified:    true,
//     },
//   });

//   console.info(`  ✓ Seed author: ${author.displayName}`);

//   // ── Sample post ───────────────────────────────────────────────────
//   const examPrepCategory = categories[0];
//   const jambTag = await prisma.tag.findUnique({ where: { slug: "jamb" } });

//   const sampleContent = JSON.stringify([
//     {
//       type: "paragraph",
//       content: "Welcome to the StudyNation blog — your go-to resource for exam prep, scholarships, student income and everything in between.",
//     },
//     {
//       type: "heading",
//       content: "What You'll Find Here",
//     },
//     {
//       type: "list",
//       items: [
//         "Expert exam guides for JAMB, WAEC, NECO and Post-UTME",
//         "Verified scholarship opportunities updated weekly",
//         "Realistic income strategies for Nigerian students",
//         "AI tools and EdTech guides",
//       ],
//     },
//     {
//       type: "tip",
//       content: "Bookmark this page and check back every Friday for fresh content written by students, for students.",
//     },
//   ]);

//   await prisma.post.upsert({
//     where: { slug: "welcome-to-studynation-blog" },
//     update: {},
//     create: {
//       slug:           "welcome-to-studynation-blog",
//       title:          "Welcome to the StudyNation Blog",
//       excerpt:        "Your go-to resource for exam prep, scholarships, student income and everything in between.",
//       content:        sampleContent,           // stored as JSON string
//       coverEmoji:     "📚",
//       coverGradient:  "from-blue-600 to-indigo-700",
//       featured:       true,
//       status:         PostStatus.PUBLISHED,
//       publishedAt:    new Date(),
//       readTimeMinutes: 2,
//       authorId:       author.id,
//       categoryId:     examPrepCategory.id,
//       ...(jambTag && {
//         tags: { create: [{ tag: { connect: { id: jambTag.id } } }] },
//       }),
//     },
//   });

//   console.info("  ✓ Sample post seeded");
//   console.info("\n✅ Seeding complete");
// }

// main()
//   .catch((e) => {
//     console.error("Seed error:", e);
//     process.exit(1);
//   })
//   .finally(() => prisma.$disconnect());


// // prisma/seed.ts
// // Seeds the database with initial categories, tags, a sample author and posts.
// // Run with: npm run db:seed

// import { PrismaClient, PostStatus } from "@prisma/client";

// const prisma = new PrismaClient();

// async function main() {
//   console.info("🌱 Seeding database…");

//   // ── Categories ──────────────────────────────────────────────────────
//   const categories = await Promise.all([
//     prisma.category.upsert({
//       where: { slug: "exam-prep" },
//       update: {},
//       create: {
//         name: "Exam Prep",
//         slug: "exam-prep",
//         description: "In-depth guides to help you score higher in JAMB, WAEC, NECO, Post-UTME and university exams.",
//         seoDescription: "Expert exam preparation guides for Nigerian students — JAMB, WAEC, NECO and university exams.",
//         coverGradient: "from-blue-600 to-indigo-700",
//         emoji: "📚",
//         sortOrder: 1,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "earn-grow" },
//       update: {},
//       create: {
//         name: "Earn & Grow",
//         slug: "earn-grow",
//         description: "Real, proven income streams for Nigerian students — from selling study notes to remote freelancing.",
//         seoDescription: "How Nigerian students earn ₦100k+ monthly — real strategies, real numbers.",
//         coverGradient: "from-emerald-500 to-teal-600",
//         emoji: "💰",
//         sortOrder: 2,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "scholarships" },
//       update: {},
//       create: {
//         name: "Scholarships",
//         slug: "scholarships",
//         description: "Verified local and international scholarships, grants and bursaries open to Nigerian students.",
//         seoDescription: "Up-to-date scholarship opportunities for Nigerian students in 2025.",
//         coverGradient: "from-rose-500 to-pink-600",
//         emoji: "🎓",
//         sortOrder: 3,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "study-tips" },
//       update: {},
//       create: {
//         name: "Study Tips",
//         slug: "study-tips",
//         description: "Science-backed study techniques, note-taking strategies and productivity habits that raise GPAs.",
//         seoDescription: "Study tips for Nigerian university students — raise your CGPA with proven methods.",
//         coverGradient: "from-violet-500 to-purple-700",
//         emoji: "👥",
//         sortOrder: 4,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "ai-tech" },
//       update: {},
//       create: {
//         name: "AI & Tech",
//         slug: "ai-tech",
//         description: "How AI and EdTech tools are changing the way Nigerian students learn and prepare.",
//         seoDescription: "AI tutoring and EdTech tools for Nigerian students — practical guides.",
//         coverGradient: "from-cyan-500 to-blue-600",
//         emoji: "🤖",
//         sortOrder: 5,
//       },
//     }),
//     prisma.category.upsert({
//       where: { slug: "remote-jobs" },
//       update: {},
//       create: {
//         name: "Remote Jobs",
//         slug: "remote-jobs",
//         description: "Flexible, student-friendly remote opportunities with real pay ranges and skill requirements.",
//         seoDescription: "Best remote jobs for Nigerian students in 2025 — real pay in naira.",
//         coverGradient: "from-orange-500 to-amber-600",
//         emoji: "💼",
//         sortOrder: 6,
//       },
//     }),
//   ]);

//   console.info(`  ✓ ${categories.length} categories seeded`);

//   // ── Tags ─────────────────────────────────────────────────────────
//   const tagData = [
//     { name: "JAMB", slug: "jamb" },
//     { name: "WAEC", slug: "waec" },
//     { name: "NECO", slug: "neco" },
//     { name: "UTME", slug: "utme" },
//     { name: "CBT", slug: "cbt" },
//     { name: "Exam Strategy", slug: "exam-strategy" },
//     { name: "Study Plan", slug: "study-plan" },
//     { name: "Side Hustle", slug: "side-hustle" },
//     { name: "Student Income", slug: "student-income" },
//     { name: "Remote Work", slug: "remote-work" },
//     { name: "Content Creation", slug: "content-creation" },
//     { name: "Freelancing", slug: "freelancing" },
//     { name: "Study Groups", slug: "study-groups" },
//     { name: "GPA", slug: "gpa" },
//     { name: "Productivity", slug: "productivity" },
//     { name: "AI", slug: "ai" },
//     { name: "EdTech", slug: "edtech" },
//     { name: "Scholarships", slug: "scholarships" },
//     { name: "Funding", slug: "funding" },
//     { name: "Career", slug: "career" },
//   ];

//   await Promise.all(
//     tagData.map((t) =>
//       prisma.tag.upsert({
//         where: { slug: t.slug },
//         update: {},
//         create: t,
//       })
//     )
//   );

//   console.info(`  ✓ ${tagData.length} tags seeded`);

//   // ── Sample author ─────────────────────────────────────────────────
//   const author = await prisma.author.upsert({
//     where: { id: "author-seed-001" },
//     update: {},
//     create: {
//       id:          "author-seed-001",
//       displayName: "Sprademia Editorial",
//       bio:         "The Sprademia editorial team.",
//       verified:    true,
//     },
//   });

//   console.info(`  ✓ Seed author: ${author.displayName}`);

//   // ── Sample post ───────────────────────────────────────────────────
//   const examPrepCategory = categories[0];
//   const jambTag = await prisma.tag.findUnique({ where: { slug: "jamb" } });

//   await prisma.post.upsert({
//     where: { slug: "welcome-to-sprademia-blog" },
//     update: {},
//     create: {
//       slug:           "welcome-to-sprademia-blog",
//       title:          "Welcome to the Sprademia Blog",
//       excerpt:        "Your go-to resource for exam prep, scholarships, student income and everything in between.",
//       content:        "# Welcome\n\nThis is the Sprademia blog. Stay tuned for expert content.",
//       contentHtml:    "<h1>Welcome</h1><p>This is the Sprademia blog. Stay tuned for expert content.</p>",
//       coverEmoji:     "📚",
//       coverGradient:  "from-blue-600 to-indigo-700",
//       featured:       true,
//       status:         PostStatus.PUBLISHED,
//       publishedAt:    new Date(),
//       readTimeMinutes: 1,
//       authorId:       author.id,
//       categoryId:     examPrepCategory.id,
//       ...(jambTag && {
//         tags: { create: [{ tag: { connect: { id: jambTag.id } } }] },
//       }),
//     },
//   });

//   console.info("  ✓ Sample post seeded");
//   console.info("\n✅ Seeding complete");
// }

// main()
//   .catch((e) => {
//     console.error("Seed error:", e);
//     process.exit(1);
//   })
//   .finally(() => prisma.$disconnect());
