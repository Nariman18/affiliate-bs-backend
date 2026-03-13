import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireAdminOrBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── GET /team ──────────────────────────────────────────────────────────────────
// Admin  → all Basic Sub-Affiliates + their manager counts / deposit totals
// Basic  → their Affiliate Managers + click / deposit / commission data
router.get(
  "/",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { userId, role } = req.user!;

      if (role === ROLES.ADMIN) {
        // Admin sees all Basic Subs with subordinate counts
        const basicSubs = await prisma.user.findMany({
          where: { role: ROLES.BASIC },
          include: {
            profile: {
              select: {
                displayName: true,
                pendingBalance: true,
                approvedBalance: true,
              },
            },
            subordinates: { select: { id: true } },
          },
          orderBy: { createdAt: "desc" },
        });

        // Enrich with deposit totals from their managers
        const enriched = await Promise.all(
          basicSubs.map(async (sub) => {
            const managerIds = sub.subordinates.map((s) => s.id);
            const [deposits, commissions] = await Promise.all([
              prisma.deposit.aggregate({
                where: { link: { affiliateId: { in: managerIds } } },
                _sum: { amount: true },
                _count: true,
              }),
              prisma.commission.aggregate({
                where: { recipientId: sub.id },
                _sum: { amount: true },
              }),
            ]);
            return {
              id: sub.id,
              username: sub.username,
              email: sub.email,
              role: sub.role,
              displayName: sub.profile?.displayName ?? sub.username,
              pendingBalance: sub.profile?.pendingBalance ?? 0,
              approvedBalance: sub.profile?.approvedBalance ?? 0,
              managerCount: managerIds.length,
              depositCount: deposits._count,
              depositVolume: deposits._sum.amount ?? 0,
              totalCommission: commissions._sum.amount ?? 0,
              joinedAt: sub.createdAt,
            };
          }),
        );

        return res.json(enriched);
      }

      // Basic Sub → their own Managers
      const managers = await prisma.user.findMany({
        where: { supervisorId: userId, role: ROLES.MANAGER },
        include: {
          profile: {
            select: {
              displayName: true,
              pendingBalance: true,
              approvedBalance: true,
            },
          },
          paymentMethods: {
            where: { isDefault: true },
            take: 1,
            select: { address: true, network: true, currency: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const enriched = await Promise.all(
        managers.map(async (mgr) => {
          const [clicks, deposits, commissions] = await Promise.all([
            prisma.click.count({ where: { link: { affiliateId: mgr.id } } }),
            prisma.deposit.aggregate({
              where: { link: { affiliateId: mgr.id } },
              _sum: { amount: true },
              _count: true,
            }),
            prisma.commission.aggregate({
              where: { recipientId: mgr.id },
              _sum: { amount: true },
            }),
          ]);
          return {
            id: mgr.id,
            username: mgr.username,
            email: mgr.email,
            role: mgr.role,
            displayName: mgr.profile?.displayName ?? mgr.username,
            pendingBalance: mgr.profile?.pendingBalance ?? 0,
            approvedBalance: mgr.profile?.approvedBalance ?? 0,
            defaultWallet: mgr.paymentMethods[0] ?? null,
            clicks,
            depositCount: deposits._count,
            depositVolume: deposits._sum.amount ?? 0,
            totalCommission: commissions._sum.amount ?? 0,
            joinedAt: mgr.createdAt,
          };
        }),
      );

      res.json(enriched);
    } catch {
      res.status(500).json({ error: "Failed to fetch team" });
    }
  },
);

// ── GET /team/:userId — member detail ──────────────────────────────────────────
router.get(
  "/:userId",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const memberId = req.params.userId as string;

      const member = await prisma.user.findUnique({
        where: { id: memberId },
        include: {
          profile: true,
          paymentMethods: { where: { isDefault: true }, take: 1 },
        },
      });
      if (!member) return res.status(404).json({ error: "User not found" });

      // Basic Sub guard: can only view their own managers
      if (
        req.user!.role === ROLES.BASIC &&
        member.supervisorId !== req.user!.userId
      ) {
        return res.status(403).json({ error: "This user is not in your team" });
      }

      const [clicks, deposits, commissions] = await Promise.all([
        prisma.click.count({ where: { link: { affiliateId: memberId } } }),
        prisma.deposit.findMany({
          where: { link: { affiliateId: memberId } },
          select: { amount: true, createdAt: true, status: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
        prisma.commission.findMany({
          where: { recipientId: memberId },
          select: { amount: true, status: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ]);

      res.json({
        id: member.id,
        username: member.username,
        email: member.email,
        role: member.role,
        supervisorId: member.supervisorId,
        displayName: member.profile?.displayName ?? member.username,
        telegramHandle: member.profile?.telegramHandle ?? null,
        pendingBalance: member.profile?.pendingBalance ?? 0,
        approvedBalance: member.profile?.approvedBalance ?? 0,
        paidBalance: member.profile?.paidBalance ?? 0,
        defaultWallet: member.paymentMethods[0] ?? null,
        clicks,
        recentDeposits: deposits,
        recentCommissions: commissions,
        joinedAt: member.createdAt,
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch team member" });
    }
  },
);

export default router;
