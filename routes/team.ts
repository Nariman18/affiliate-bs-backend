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
// Admin → ALL non-admin users (both BASIC + MANAGER) in one list
// Basic Sub → only their own supervised managers
router.get(
  "/",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { userId, role } = req.user!;

      if (role === ROLES.ADMIN) {
        // All BASIC + all MANAGER users
        const users = await prisma.user.findMany({
          where: { role: { in: [ROLES.BASIC as any, ROLES.MANAGER as any] } },
          include: {
            profile: {
              select: {
                displayName: true,
                pendingBalance: true,
                approvedBalance: true,
                paidBalance: true,
                avatarUrl: true, // <-- ADDED THIS
              },
            },
            paymentMethods: {
              where: { isDefault: true },
              take: 1,
              select: { address: true, network: true, currency: true },
            },
            subordinates: { select: { id: true } },
            supervisor: { select: { id: true, username: true, role: true } },
          },
          orderBy: { createdAt: "desc" },
        });

        const enriched = await Promise.all(
          users.map(async (u) => {
            const [clicks, deposits] = await Promise.all([
              prisma.click.count({ where: { link: { affiliateId: u.id } } }),
              prisma.deposit.aggregate({
                where: { link: { affiliateId: u.id } },
                _sum: { amount: true },
                _count: true,
              }),
            ]);
            return {
              id: u.id,
              username: u.username,
              email: u.email,
              role: u.role,
              displayName: u.profile?.displayName ?? u.username,
              avatarUrl: u.profile?.avatarUrl ?? null, // <-- ADDED THIS
              pendingBalance: u.profile?.pendingBalance ?? 0,
              approvedBalance: u.profile?.approvedBalance ?? 0,
              paidBalance: u.profile?.paidBalance ?? 0,
              defaultWallet: u.paymentMethods[0] ?? null,
              supervisorId: u.supervisorId,
              supervisorName: u.supervisor?.username ?? null,
              managerCount: u.subordinates.length, // for BASIC users: how many managers under them
              clicks,
              depositCount: deposits._count,
              depositVolume: deposits._sum.amount ?? 0,
              joinedAt: u.createdAt,
            };
          }),
        );

        return res.json(enriched);
      }

      // BASIC SUB → only their supervised managers
      const managers = await prisma.user.findMany({
        where: { supervisorId: userId },
        include: {
          profile: {
            select: {
              displayName: true,
              pendingBalance: true,
              approvedBalance: true,
              paidBalance: true,
              avatarUrl: true, // <-- ADDED THIS
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
          const [clicks, deposits] = await Promise.all([
            prisma.click.count({ where: { link: { affiliateId: mgr.id } } }),
            prisma.deposit.aggregate({
              where: { link: { affiliateId: mgr.id } },
              _sum: { amount: true },
              _count: true,
            }),
          ]);
          return {
            id: mgr.id,
            username: mgr.username,
            email: mgr.email,
            role: mgr.role,
            displayName: mgr.profile?.displayName ?? mgr.username,
            avatarUrl: mgr.profile?.avatarUrl ?? null, // <-- ADDED THIS
            pendingBalance: mgr.profile?.pendingBalance ?? 0,
            approvedBalance: mgr.profile?.approvedBalance ?? 0,
            paidBalance: mgr.profile?.paidBalance ?? 0,
            defaultWallet: mgr.paymentMethods[0] ?? null,
            managerCount: 0,
            clicks,
            depositCount: deposits._count,
            depositVolume: deposits._sum.amount ?? 0,
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

// ── GET /team/:userId — full member detail with analytics ─────────────────────
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
          profile: true, // Because this is true, avatarUrl is already fetched from DB here!
          paymentMethods: { where: { isDefault: true }, take: 1 },
          supervisor: { select: { id: true, username: true, role: true } },
          subordinates: {
            select: {
              id: true,
              username: true,
              email: true,
              role: true,
              createdAt: true,
            },
            take: 10,
          },
        },
      });
      if (!member) return res.status(404).json({ error: "User not found" });

      // Access control: Basic Sub can only view their own managers
      if (
        req.user!.role === ROLES.BASIC &&
        member.supervisorId !== req.user!.userId
      ) {
        return res.status(403).json({ error: "This user is not in your team" });
      }

      // Full analytics
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      const [clicks, deposits, recentDeposits, links] = await Promise.all([
        prisma.click.count({ where: { link: { affiliateId: memberId } } }),
        prisma.deposit.aggregate({
          where: { link: { affiliateId: memberId } },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.deposit.findMany({
          where: { link: { affiliateId: memberId } },
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            createdAt: true,
            link: { select: { offer: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
        prisma.link.findMany({
          where: { affiliateId: memberId },
          include: {
            offer: { select: { name: true, category: true } },
            _count: { select: { clicks: true, deposits: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      // 30-day stats
      const [clicks30d, deposits30d] = await Promise.all([
        prisma.click.count({
          where: {
            link: { affiliateId: memberId },
            createdAt: { gte: thirtyDaysAgo },
          },
        }),
        prisma.deposit.aggregate({
          where: {
            link: { affiliateId: memberId },
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { amount: true },
          _count: true,
        }),
      ]);

      res.json({
        id: member.id,
        username: member.username,
        email: member.email,
        role: member.role,
        supervisorId: member.supervisorId,
        supervisorName: member.supervisor?.username ?? null,
        displayName: member.profile?.displayName ?? member.username,
        avatarUrl: member.profile?.avatarUrl ?? null, // <-- ADDED THIS
        telegramHandle: member.profile?.telegramHandle ?? null,
        pendingBalance: member.profile?.pendingBalance ?? 0,
        approvedBalance: member.profile?.approvedBalance ?? 0,
        paidBalance: member.profile?.paidBalance ?? 0,
        defaultWallet: member.paymentMethods[0] ?? null,
        // All-time stats
        totalClicks: clicks,
        totalDeposits: deposits._count,
        totalRevenue: deposits._sum.amount ?? 0,
        // 30-day stats
        clicks30d,
        deposits30d: deposits30d._count,
        revenue30d: deposits30d._sum.amount ?? 0,
        // Detail data
        recentDeposits,
        links,
        // For BASIC users: their team
        subordinates: member.subordinates,
        joinedAt: member.createdAt,
      });
    } catch {
      res.status(500).json({ error: "Failed to fetch member" });
    }
  },
);

export default router;
