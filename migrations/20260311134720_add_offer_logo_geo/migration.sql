/*
  Warnings:

  - The values [APPROVAL_REQUESTED,REJECTED] on the enum `PaymentStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `approvalRequestedAt` on the `Commission` table. All the data in the column will be lost.
  - You are about to drop the column `resolvedAt` on the `Commission` table. All the data in the column will be lost.
  - You are about to drop the column `resolvedNote` on the `Commission` table. All the data in the column will be lost.
  - You are about to drop the column `targetUrl` on the `Link` table. All the data in the column will be lost.
  - You are about to drop the column `ftdAmount` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `regAmount` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `rules` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `markupPercentage` on the `UserProfile` table. All the data in the column will be lost.
  - Added the required column `casinoUrl` to the `Link` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PaymentStatus_new" AS ENUM ('PENDING', 'APPROVED', 'PAID');
ALTER TABLE "Commission" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PayoutRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Commission" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING ("status"::text::"PaymentStatus_new");
ALTER TABLE "PayoutRequest" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING ("status"::text::"PaymentStatus_new");
ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";
ALTER TYPE "PaymentStatus_new" RENAME TO "PaymentStatus";
DROP TYPE "PaymentStatus_old";
ALTER TABLE "Commission" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "PayoutRequest" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "Commission" DROP COLUMN "approvalRequestedAt",
DROP COLUMN "resolvedAt",
DROP COLUMN "resolvedNote",
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "requestedApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requestedApprovalAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Deposit" ALTER COLUMN "status" SET DEFAULT 'confirmed';

-- AlterTable
ALTER TABLE "Link" DROP COLUMN "targetUrl",
ADD COLUMN     "casinoUrl" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Offer" DROP COLUMN "ftdAmount",
DROP COLUMN "regAmount",
DROP COLUMN "rules",
ADD COLUMN     "casinoUrl" TEXT,
ADD COLUMN     "geoTargets" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "minDeposit" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "UserProfile" DROP COLUMN "markupPercentage",
ADD COLUMN     "paidBalance" DOUBLE PRECISION NOT NULL DEFAULT 0;
