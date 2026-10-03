/*
  Warnings:

  - You are about to drop the column `customPrompt` on the `AiSettings` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "model" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "timeoutSeconds" INTEGER,
    "extraBody" TEXT,
    "instructions" TEXT,
    "groupWindowSeconds" INTEGER NOT NULL DEFAULT 60,
    "similarity" TEXT NOT NULL DEFAULT 'similar',
    "imageMaxPx" INTEGER NOT NULL DEFAULT 768,
    "maxGroupSize" INTEGER NOT NULL DEFAULT 12,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiSettings" ("apiKeyEnc", "baseUrl", "enabled", "extraBody", "groupWindowSeconds", "id", "imageMaxPx", "maxGroupSize", "maxTokens", "model", "similarity", "temperature", "timeoutSeconds", "updatedAt") SELECT "apiKeyEnc", "baseUrl", "enabled", "extraBody", "groupWindowSeconds", "id", "imageMaxPx", "maxGroupSize", "maxTokens", "model", "similarity", "temperature", "timeoutSeconds", "updatedAt" FROM "AiSettings";
DROP TABLE "AiSettings";
ALTER TABLE "new_AiSettings" RENAME TO "AiSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
