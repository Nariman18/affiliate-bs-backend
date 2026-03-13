import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest, ROLES } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getDateRange(from?: string, to?: string) {
  const now = new Date();
  const start = from
    ? new Date(from)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = to ? new Date(to) : now;
  return { start, end };
}

// Builds a Prisma `where` clause for the Link model based on role.
// MANAGER : their own links
// BASIC   : their managers' links
// ADMIN   : all links (empty where = unrestricted)
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

// ── GET /reports/overview ──────────────────────────────────────────────────────
router.get("/overview", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    const linkWhere = await getLinkWhere(userId, role);

    if (role === ROLES.ADMIN) {
      const [teamSize, totalDeposits, commStats, payoutStats] =
        await Promise.all([
          prisma.user.count({ where: { role: ROLES.BASIC } }),
          prisma.deposit.aggregate({
            where: { link: linkWhere, createdAt: { gte: start, lte: end } },
            _sum: { amount: true },
            _count: true,
          }),
          prisma.commission.aggregate({
            where: { status: "PENDING", createdAt: { gte: start, lte: end } },
            _sum: { amount: true },
          }),
          prisma.payoutRequest.aggregate({
            where: { status: "PENDING" },
            _sum: { amount: true },
          }),
        ]);

      return res.json({
        teamSize,
        totalDeposits: totalDeposits._count,
        totalRevenue: totalDeposits._sum.amount ?? 0,
        pendingCommissions: commStats._sum.amount ?? 0,
        pendingPayouts: payoutStats._sum.amount ?? 0,
      });
    }

    if (role === ROLES.BASIC) {
      const [teamSize, deposits, myCommissions] = await Promise.all([
        prisma.user.count({ where: { supervisorId: userId } }),
        prisma.deposit.aggregate({
          where: { link: linkWhere, createdAt: { gte: start, lte: end } },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.commission.groupBy({
          by: ["status"],
          where: { recipientId: userId },
          _sum: { amount: true },
        }),
      ]);

      const commByStatus = Object.fromEntries(
        myCommissions.map((c) => [c.status, c._sum.amount ?? 0]),
      );
      return res.json({
        teamSize,
        totalDeposits: deposits._count,
        totalRevenue: deposits._sum.amount ?? 0,
        pendingCommission: commByStatus["PENDING"] ?? 0,
        approvedCommission: commByStatus["APPROVED"] ?? 0,
        paidCommission: commByStatus["PAID"] ?? 0,
      });
    }

    // MANAGER
    const [clicks, deposits, myCommissions] = await Promise.all([
      prisma.click.count({
        where: {
          link: { affiliateId: userId },
          createdAt: { gte: start, lte: end },
        },
      }),
      prisma.deposit.aggregate({
        where: {
          link: { affiliateId: userId },
          createdAt: { gte: start, lte: end },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.commission.groupBy({
        by: ["status"],
        where: { recipientId: userId },
        _sum: { amount: true },
      }),
    ]);

    const commByStatus = Object.fromEntries(
      myCommissions.map((c) => [c.status, c._sum.amount ?? 0]),
    );
    res.json({
      clicks,
      conversions: deposits._count,
      totalRevenue: deposits._sum.amount ?? 0,
      pendingCommission: commByStatus["PENDING"] ?? 0,
      approvedCommission: commByStatus["APPROVED"] ?? 0,
      paidCommission: commByStatus["PAID"] ?? 0,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch overview" });
  }
});

// ── GET /reports/general — daily aggregates ────────────────────────────────────
router.get("/general", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    const linkWhere = await getLinkWhere(userId, role);

    const [clicks, deposits] = await Promise.all([
      prisma.click.findMany({
        where: { link: linkWhere, createdAt: { gte: start, lte: end } },
        select: { createdAt: true, isUnique: true, isInvalid: true },
      }),
      prisma.deposit.findMany({
        where: { link: linkWhere, createdAt: { gte: start, lte: end } },
        select: { createdAt: true, amount: true, status: true },
      }),
    ]);

    const dayMap: Record<string, any> = {};

    const getDay = (d: Date) => d.toISOString().slice(0, 10);
    const ensure = (key: string) => {
      if (!dayMap[key]) {
        dayMap[key] = {
          date: key,
          gross: 0,
          unique: 0,
          invalid: 0,
          depositsCount: 0,
          revenue: 0,
        };
      }
    };

    for (const c of clicks) {
      const k = getDay(c.createdAt);
      ensure(k);
      dayMap[k].gross++;
      if (c.isUnique) dayMap[k].unique++;
      if (c.isInvalid) dayMap[k].invalid++;
    }
    for (const d of deposits) {
      const k = getDay(d.createdAt);
      ensure(k);
      dayMap[k].depositsCount++;
      dayMap[k].revenue += d.amount;
    }

    const rows = Object.values(dayMap).sort((a: any, b: any) =>
      a.date.localeCompare(b.date),
    );
    const totals = rows.reduce((acc: any, row: any) => {
      for (const k of [
        "gross",
        "unique",
        "invalid",
        "depositsCount",
        "revenue",
      ])
        acc[k] = (acc[k] ?? 0) + row[k];
      return acc;
    }, {});

    res.json({ rows, totals });
  } catch {
    res.status(500).json({ error: "Failed to fetch general report" });
  }
});

// ── GET /reports/by-offer ──────────────────────────────────────────────────────
router.get("/by-offer", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    const linkWhere = await getLinkWhere(userId, role);

    const links = await prisma.link.findMany({
      where: linkWhere,
      include: {
        offer: { select: { name: true, category: true } },
        clicks: {
          where: { createdAt: { gte: start, lte: end } },
          select: { isUnique: true },
        },
        deposits: {
          where: { createdAt: { gte: start, lte: end } },
          select: { amount: true, status: true },
        },
      },
    });

    const offerMap: Record<string, any> = {};
    for (const link of links) {
      const key = link.offerId;
      if (!offerMap[key]) {
        offerMap[key] = {
          offerId: key,
          offerName: link.offer?.name ?? "—",
          clicks: 0,
          unique: 0,
          conversions: 0,
          revenue: 0,
        };
      }
      offerMap[key].clicks += link.clicks.length;
      offerMap[key].unique += link.clicks.filter((c) => c.isUnique).length;
      offerMap[key].conversions += link.deposits.length;
      offerMap[key].revenue += link.deposits.reduce((s, d) => s + d.amount, 0);
    }

    res.json(Object.values(offerMap));
  } catch {
    res.status(500).json({ error: "Failed to fetch offer report" });
  }
});

// ── GET /reports/by-country ────────────────────────────────────────────────────
router.get("/by-country", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    const linkWhere = await getLinkWhere(userId, role);

    const clicks = await prisma.click.findMany({
      where: { link: linkWhere, createdAt: { gte: start, lte: end } },
      select: { country: true, isUnique: true },
    });

    const map: Record<string, any> = {};
    for (const c of clicks) {
      const key = c.country ?? "Unknown";
      if (!map[key]) map[key] = { country: key, clicks: 0, unique: 0 };
      map[key].clicks++;
      if (c.isUnique) map[key].unique++;
    }

    res.json(Object.values(map).sort((a: any, b: any) => b.clicks - a.clicks));
  } catch {
    res.status(500).json({ error: "Failed to fetch country report" });
  }
});

// ── GET /reports/by-device ─────────────────────────────────────────────────────
router.get("/by-device", authenticate, async (req: AuthRequest, res) => {
  try {
    const { userId, role } = req.user!;
    const { from, to } = req.query;
    const { start, end } = getDateRange(from as string, to as string);
    const linkWhere = await getLinkWhere(userId, role);

    const clicks = await prisma.click.findMany({
      where: { link: linkWhere, createdAt: { gte: start, lte: end } },
      select: { deviceType: true, os: true },
    });

    const deviceMap: Record<string, number> = {};
    const osMap: Record<string, number> = {};
    for (const c of clicks) {
      const dt = c.deviceType ?? "unknown";
      const os = c.os ?? "unknown";
      deviceMap[dt] = (deviceMap[dt] ?? 0) + 1;
      osMap[os] = (osMap[os] ?? 0) + 1;
    }

    res.json({ byDevice: deviceMap, byOS: osMap });
  } catch {
    res.status(500).json({ error: "Failed to fetch device report" });
  }
});

export default router;
