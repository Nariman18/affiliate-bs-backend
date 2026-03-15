import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  authenticate,
  requireAdmin,
  requireBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

async function buildRecipientFilter(userId: string, role: string) {
  if (role === ROLES.ADMIN) return {};
  if (role === ROLES.BASIC) {
    const team = await prisma.user.findMany({
      where: { supervisorId: userId },
      select: { id: true },
    });
    return { recipientId: { in: [userId, ...team.map((m) => m.id)] } };
  }
  return { recipientId: userId };
}

function groupByRecipient(rows: { recipientId: string; amount: number }[]) {
  const map = new Map<string, number>();
  for (const r of rows)
    map.set(r.recipientId, (map.get(r.recipientId) ?? 0) + r.amount);
  return map;
}

// ── GET /commissions ───────────────────────────────────────────────────────────
router.get("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const recipientFilter = await buildRecipientFilter(
      req.user!.userId,
      req.user!.role,
    );

    const where: any = { ...recipientFilter, ...(status ? { status } : {}) };

    const [items, total] = await Promise.all([
      prisma.commission.findMany({
        where,
        include: {
          recipient: { select: { username: true, email: true, role: true } },
          deposit: {
            select: {
              amount: true,
              currency: true,
              createdAt: true,
              link: { select: { offer: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.commission.count({ where }),
    ]);

    res.json({ items, total, page: parseInt(page as string), limit: take });
  } catch {
    res.status(500).json({ error: "Failed to fetch commissions" });
  }
});

// ── GET /commissions/stats ─────────────────────────────────────────────────────
router.get("/stats", authenticate, async (req: AuthRequest, res) => {
  try {
    const recipientFilter = await buildRecipientFilter(
      req.user!.userId,
      req.user!.role,
    );
    const [pending, approved, paid] = await Promise.all([
      prisma.commission.aggregate({
        where: { ...recipientFilter, status: "PENDING" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.commission.aggregate({
        where: { ...recipientFilter, status: "APPROVED" },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.commission.aggregate({
        where: { ...recipientFilter, status: "PAID" },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    res.json({
      pending: { count: pending._count, amount: pending._sum.amount ?? 0 },
      approved: { count: approved._count, amount: approved._sum.amount ?? 0 },
      paid: { count: paid._count, amount: paid._sum.amount ?? 0 },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch commission stats" });
  }
});

// ── POST /commissions/request-approval — Basic Sub flags commissions ───────────
router.post(
  "/request-approval",
  authenticate,
  requireBasic,
  async (req: AuthRequest, res) => {
    try {
      const { commissionIds } = req.body as { commissionIds: string[] };
      if (!Array.isArray(commissionIds) || !commissionIds.length)
        return res
          .status(400)
          .json({ error: "commissionIds must be a non-empty array" });

      const teamMembers = await prisma.user.findMany({
        where: { supervisorId: req.user!.userId },
        select: { id: true },
      });
      const allowedIds = new Set([
        req.user!.userId,
        ...teamMembers.map((m) => m.id),
      ]);

      const commissions = await prisma.commission.findMany({
        where: { id: { in: commissionIds } },
        select: { id: true, status: true, recipientId: true },
      });

      const unauthorized = commissions.filter(
        (c) => !allowedIds.has(c.recipientId),
      );
      if (unauthorized.length)
        return res
          .status(403)
          .json({ error: "Some commissions do not belong to your team" });

      const notPending = commissions.filter((c) => c.status !== "PENDING");
      if (notPending.length)
        return res
          .status(400)
          .json({
            error: "Only PENDING commissions can be submitted for approval",
          });

      const updated = await prisma.commission.updateMany({
        where: { id: { in: commissionIds }, status: "PENDING" },
        data: { requestedApproval: true, requestedApprovalAt: new Date() },
      });
      res.json({ success: true, flagged: updated.count });
    } catch {
      res.status(500).json({ error: "Failed to request approval" });
    }
  },
);

// ── PATCH /commissions/:id/approve — Admin PENDING → APPROVED ─────────────────
router.patch(
  "/:id/approve",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { note } = req.body;
      const commission = await prisma.commission.findUnique({ where: { id } });
      if (!commission)
        return res.status(404).json({ error: "Commission not found" });
      if (commission.status !== "PENDING")
        return res
          .status(400)
          .json({ error: `Commission is already ${commission.status}` });

      await prisma.$transaction(async (tx) => {
        await tx.commission.update({
          where: { id },
          data: {
            status: "APPROVED",
            approvedAt: new Date(),
            note: note ?? null,
          },
        });
        await tx.userProfile.update({
          where: { userId: commission.recipientId },
          data: {
            pendingBalance: { decrement: commission.amount },
            approvedBalance: { increment: commission.amount },
          },
        });
      });
      res.json({ success: true, status: "APPROVED" });
    } catch {
      res.status(500).json({ error: "Failed to approve commission" });
    }
  },
);

// ── PATCH /commissions/:id/pay — Admin APPROVED → PAID ────────────────────────
router.patch(
  "/:id/pay",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const id = req.params.id as string;
      const { note } = req.body;
      const commission = await prisma.commission.findUnique({ where: { id } });
      if (!commission)
        return res.status(404).json({ error: "Commission not found" });
      if (commission.status !== "APPROVED")
        return res
          .status(400)
          .json({ error: "Only APPROVED commissions can be marked PAID" });

      await prisma.$transaction(async (tx) => {
        await tx.commission.update({
          where: { id },
          data: { status: "PAID", paidAt: new Date(), note: note ?? null },
        });
        await tx.userProfile.update({
          where: { userId: commission.recipientId },
          data: {
            approvedBalance: { decrement: commission.amount },
            paidBalance: { increment: commission.amount },
          },
        });
      });
      res.json({ success: true, status: "PAID" });
    } catch {
      res.status(500).json({ error: "Failed to mark commission as paid" });
    }
  },
);

// ── POST /commissions/bulk-approve ────────────────────────────────────────────
router.post(
  "/bulk-approve",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { ids, note } = req.body as { ids: string[]; note?: string };
      if (!Array.isArray(ids) || !ids.length)
        return res.status(400).json({ error: "ids required" });

      const commissions = await prisma.commission.findMany({
        where: { id: { in: ids }, status: "PENDING" },
        select: { id: true, recipientId: true, amount: true },
      });
      if (!commissions.length)
        return res
          .status(400)
          .json({ error: "No eligible PENDING commissions" });

      const totals = groupByRecipient(commissions);
      await prisma.$transaction(async (tx) => {
        await tx.commission.updateMany({
          where: { id: { in: commissions.map((c) => c.id) } },
          data: {
            status: "APPROVED",
            approvedAt: new Date(),
            note: note ?? null,
          },
        });
        for (const [recipientId, total] of totals) {
          await tx.userProfile.update({
            where: { userId: recipientId },
            data: {
              pendingBalance: { decrement: total },
              approvedBalance: { increment: total },
            },
          });
        }
      });
      res.json({ success: true, approved: commissions.length });
    } catch {
      res.status(500).json({ error: "Bulk approve failed" });
    }
  },
);

// ── POST /commissions/bulk-pay ─────────────────────────────────────────────────
router.post(
  "/bulk-pay",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res) => {
    try {
      const { ids, note } = req.body as { ids: string[]; note?: string };
      if (!Array.isArray(ids) || !ids.length)
        return res.status(400).json({ error: "ids required" });

      const commissions = await prisma.commission.findMany({
        where: { id: { in: ids }, status: "APPROVED" },
        select: { id: true, recipientId: true, amount: true },
      });
      if (!commissions.length)
        return res
          .status(400)
          .json({ error: "No eligible APPROVED commissions" });

      const totals = groupByRecipient(commissions);
      await prisma.$transaction(async (tx) => {
        await tx.commission.updateMany({
          where: { id: { in: commissions.map((c) => c.id) } },
          data: { status: "PAID", paidAt: new Date(), note: note ?? null },
        });
        for (const [recipientId, total] of totals) {
          await tx.userProfile.update({
            where: { userId: recipientId },
            data: {
              approvedBalance: { decrement: total },
              paidBalance: { increment: total },
            },
          });
        }
      });
      res.json({ success: true, paid: commissions.length });
    } catch {
      res.status(500).json({ error: "Bulk pay failed" });
    }
  },
);

export default router;
