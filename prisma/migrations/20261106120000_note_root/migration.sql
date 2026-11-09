-- AlterTable
ALTER TABLE "TempNote" ADD COLUMN "root" TEXT NOT NULL DEFAULT 'temp';

-- DropIndex
DROP INDEX "TempNote_folder_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "TempNote_root_folder_name_key" ON "TempNote"("root", "folder", "name");
