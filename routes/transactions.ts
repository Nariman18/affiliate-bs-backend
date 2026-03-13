import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest, ROLES } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

async function getLinkWhere(userId: string, role: string) {
  if (role === ROLES.ADMIN) return {};
  if (role === ROLES.BASIC) {
    const ids = await prisma.user
      .findMany({ where: { supervisorId: userId }, select: { id: true } })
      .then((u) => u.map((x) => x.id));
    return { affiliateId: { in: ids } };
  }
  return { affiliateId: userId };
}

// ── GET /transactions/conversions ──────────────────────────────────────────────
router.get("/conversions", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to, offerId, status, page = "1", limit = "50" } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const linkWhere = await getLinkWhere(userId, role);

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);

    const where: any = {
      link: {
        ...linkWhere,
        ...(offerId ? { offerId } : {}),
      },
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      ...(status ? { status } : {}),
    };

    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where,
        include: {
          link: {
            select: {
              id: true,
              name: true,
              subId: true,
              affiliateId: true,
              offer: { select: { name: true, category: true } },
            },
          },
          // Only show the current user's own commission on each deposit
          commissions: {
            where: { recipientId: userId },
            select: { amount: true, percentage: true, status: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.deposit.count({ where }),
    ]);

    res.json({
      data: deposits,
      total,
      page: parseInt(page as string),
      limit: take,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch conversions" });
  }
});

// ── GET /transactions/clicks ───────────────────────────────────────────────────
router.get("/clicks", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to, invalid, page = "1", limit = "50" } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const linkWhere = await getLinkWhere(userId, role);

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);

    const where: any = {
      link: linkWhere,
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      ...(invalid !== undefined ? { isInvalid: invalid === "true" } : {}),
    };

    const [clicks, total] = await Promise.all([
      prisma.click.findMany({
        where,
        include: {
          link: {
            select: {
              id: true,
              name: true,
              subId: true,
              affiliateId: true,
              offer: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.click.count({ where }),
    ]);

    res.json({
      data: clicks,
      total,
      page: parseInt(page as string),
      limit: take,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch clicks" });
  }
});

// ── GET /transactions/postbacks — deposit postback log ────────────────────────
router.get("/postbacks", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const linkWhere = await getLinkWhere(userId, role);

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);

    const deposits = await prisma.deposit.findMany({
      where: {
        link: linkWhere,
        ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        amount: true,
        currency: true,
        status: true,
        subId: true,
        link: { select: { id: true, name: true } },
        commissions: {
          where: { recipientId: userId },
          select: { amount: true, percentage: true, status: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    res.json(deposits);
  } catch {
    res.status(500).json({ error: "Failed to fetch postbacks" });
  }
});

export default router;
