/*
  Warnings:

  - You are about to drop the column `cryptoWalletAddress` on the `AffiliateProfile` table. All the data in the column will be lost.
  - You are about to drop the column `networkType` on the `AffiliateProfile` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[username]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "AffiliateProfile" DROP COLUMN "cryptoWalletAddress",
DROP COLUMN "networkType",
ADD COLUMN     "telegramHandle" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "username" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
