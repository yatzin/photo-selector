-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "screenshotInstructions" TEXT;

-- CreateTable
CREATE TABLE "AiShot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "takenAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "error" TEXT,
    CONSTRAINT "AiShot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'similar',
    "root" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "fresh" BOOLEAN NOT NULL DEFAULT false,
    "includeDays" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "groupCount" INTEGER NOT NULL DEFAULT 0,
    "analyzedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "groupedAt" DATETIME,
    "snapshot" TEXT,
    "finishedAt" DATETIME,
    CONSTRAINT "AiRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AiRun" ("analyzedCount", "createdAt", "createdById", "error", "failedCount", "finishedAt", "folder", "fresh", "groupCount", "groupedAt", "id", "includeDays", "model", "photoCount", "root", "snapshot", "startedAt", "status") SELECT "analyzedCount", "createdAt", "createdById", "error", "failedCount", "finishedAt", "folder", "fresh", "groupCount", "groupedAt", "id", "includeDays", "model", "photoCount", "root", "snapshot", "startedAt", "status" FROM "AiRun";
DROP TABLE "AiRun";
ALTER TABLE "new_AiRun" RENAME TO "AiRun";
CREATE INDEX "AiRun_status_createdAt_idx" ON "AiRun"("status", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AiShot_root_folder_status_idx" ON "AiShot"("root", "folder", "status");

-- CreateIndex
CREATE INDEX "AiShot_runId_status_idx" ON "AiShot"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiShot_runId_name_key" ON "AiShot"("runId", "name");
