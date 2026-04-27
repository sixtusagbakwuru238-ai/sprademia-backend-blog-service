-- Migration: allow guest comments on posts
-- Run: npx prisma migrate deploy

-- Make authorId nullable (guests have no account)
ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL;

-- Add guest commenter fields
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "guest_name"  TEXT;
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "guest_email" TEXT;
