/*
  Warnings:

  - The values [ADMIN,PARTNER,AFFILIATE,SUB_AFFILIATE] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `connectionType` on the `Click` table. All the data in the column will be lost.
  - You are about to drop the column `affiliateId` on the `Commission` table. All the data in the column will be lost.
  - The `status` column on the `Commission` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `commissionCalc` on the `Deposit` table. All the data in the column will be lost.
  - You are about to drop the column `partnerId` on the `Link` table. All the data in the column will be lost.
  - You are about to drop the column `targetUrl` on the `Link` table. All the data in the column will be lost.
  - You are about to drop the column `ftdAmount` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `markupPercentage` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `partnerId` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `regAmount` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `rules` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `walletId` on the `PayoutRequest` table. All the data in the column will be lost.
  - The `status` column on the `PayoutRequest` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `invitedById` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `AffiliateProfile` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Partner` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Referral` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `recipientId` to the `Commission` table without a default value. This is not possible if the table is not empty.
  - Added the required column `casinoUrl` to the `Link` table without a default value. This is not possible if the table is not empty.
  - Made the column `affiliateId` on table `Link` required. This step will fail if there are existing NULL values in that column.
  - Made the column `offerId` on table `Link` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `createdById` to the `Offer` table without a default value. This is not possible if the table is not empty.
  - Made the column `username` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID');

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ADMIN_SUB_AFFILIATE', 'BASIC_SUB_AFFILIATE', 'AFFILIATE_MANAGER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'AFFILIATE_MANAGER';
COMMIT;

-- DropForeignKey
ALTER TABLE "AffiliateProfile" DROP CONSTRAINT "AffiliateProfile_userId_fkey";

-- DropForeignKey
ALTER TABLE "Link" DROP CONSTRAINT "Link_offerId_fkey";

-- DropForeignKey
ALTER TABLE "Link" DROP CONSTRAINT "Link_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "Offer" DROP CONSTRAINT "Offer_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "Partner" DROP CONSTRAINT "Partner_userId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_receiverId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_senderId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_invitedById_fkey";

-- DropIndex
DROP INDEX "Commission_depositId_key";

-- AlterTable
ALTER TABLE "Click" DROP COLUMN "connectionType";

-- AlterTable
ALTER TABLE "Commission" DROP COLUMN "affiliateId",
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "recipientId" TEXT NOT NULL,
ADD COLUMN     "requestedApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestedApprovalAt" TIMESTAMP(3),
ALTER COLUMN "percentage" SET DEFAULT 10,
DROP COLUMN "status",
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Deposit" DROP COLUMN "commissionCalc",
ALTER COLUMN "status" SET DEFAULT 'confirmed';

-- AlterTable
ALTER TABLE "Link" DROP COLUMN "partnerId",
DROP COLUMN "targetUrl",
ADD COLUMN     "casinoUrl" TEXT NOT NULL,
ALTER COLUMN "affiliateId" SET NOT NULL,
ALTER COLUMN "offerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Offer" DROP COLUMN "ftdAmount",
DROP COLUMN "markupPercentage",
DROP COLUMN "partnerId",
DROP COLUMN "regAmount",
DROP COLUMN "rules",
ADD COLUMN     "casinoUrl" TEXT,
ADD COLUMN     "commissionPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
ADD COLUMN     "createdById" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "PayoutRequest" DROP COLUMN "walletId",
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paymentMethodId" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "invitedById",
ADD COLUMN     "supervisorId" TEXT,
ALTER COLUMN "role" SET DEFAULT 'AFFILIATE_MANAGER',
ALTER COLUMN "username" SET NOT NULL;

-- DropTable
DROP TABLE "AffiliateProfile";

-- DropTable
DROP TABLE "Partner";

-- DropTable
DROP TABLE "Referral";

-- DropEnum
DROP TYPE "PayoutStatus";

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "telegramHandle" TEXT,
    "pendingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "approvedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
