import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest, ROLES } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// FIX 1: Make sure the "to" date includes the ENTIRE day until 23:59:59
function getDateRange(from?: string, to?: string) {
  const now = new Date();
  const start = from
    ? new Date(from)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = to ? new Date(to) : now;

  if (to) {
    end.setUTCHours(23, 59, 59, 999);
  }

  return { start, end };
}

// FIX 2: Ensure Basic Subs see their own links in addition to their team's
async function getLinkWhere(userId: string, role: string) {
  if (role === ROLES.ADMIN) return {};
  if (role === ROLES.BASIC) {
    const ids = await prisma.user
      .findMany({ where: { supervisorId: userId }, select: { id: true } })
      .then((u) => u.map((x) => x.id));

    ids.push(userId); // <--- Injects the Basic Sub's own ID

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

    // ── Common Quick Stats (all roles) ──────────────────────────────────────────
    const [clicksData, depositsData, profile] = await Promise.all([
      prisma.click.findMany({
        where: { link: linkWhere, createdAt: { gte: start, lte: end } },
        select: { isUnique: true },
      }),
      prisma.deposit.aggregate({
        where: { link: linkWhere, createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.userProfile.findUnique({
        where: { userId },
        select: {
          pendingBalance: true,
          approvedBalance: true,
          paidBalance: true,
        },
      }),
    ]);

    const totalClicks = clicksData.length;
    const uniqueClicks = clicksData.filter((c) => c.isUnique).length;
    const conversions = depositsData._count;
    const totalRevenue = depositsData._sum.amount ?? 0;
    const pendingBalance = profile?.pendingBalance ?? 0;
    const approvedBalance = profile?.approvedBalance ?? 0;
    const paidBalance = profile?.paidBalance ?? 0;

    // ── Role-specific hero stats ────────────────────────────────────────────────
    if (role === ROLES.ADMIN) {
      const [totalAffiliates, pendingPayouts] = await Promise.all([
        prisma.user.count({ where: { role: { not: ROLES.ADMIN as any } } }),
        prisma.payoutRequest.aggregate({
          where: { status: "PENDING" },
          _sum: { amount: true },
        }),
      ]);

      return res.json({
        totalAffiliates,
        totalClicks,
        totalRevenue,
        pendingPayouts: pendingPayouts._sum.amount ?? 0,
        uniqueClicks,
        registrations: 0,
        conversions,
        approvedBalance,
        pendingBalance,
        paidBalance,
      });
    }

    if (role === ROLES.BASIC) {
      const teamSize = await prisma.user.count({
        where: { supervisorId: userId },
      });

      return res.json({
        teamSize,
        approvedBalance,
        pendingBalance,
        totalRevenue,
        totalClicks,
        uniqueClicks,
        registrations: 0,
        conversions,
        paidBalance,
      });
    }

    // MANAGER
    return res.json({
      approvedBalance,
      pendingBalance,
      totalClicks,
      conversions,
      uniqueClicks,
      registrations: 0,
      totalRevenue,
      paidBalance,
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
      if (!dayMap[key])
        dayMap[key] = {
          date: key,
          gross: 0,
          unique: 0,
          invalid: 0,
          approved: 0,
          pending: 0,
          rejected: 0,
          revenue: 0,
          commission: 0,
        };
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
      if (d.status === "confirmed") dayMap[k].approved++;
      else if (d.status === "pending") dayMap[k].pending++;
      else dayMap[k].rejected++;
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
        "approved",
        "pending",
        "rejected",
        "revenue",
        "commission",
      ])
        acc[k] = (acc[k] ?? 0) + (row[k] ?? 0);
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
          commission: 0,
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
      if (!map[key])
        map[key] = { country: key, clicks: 0, unique: 0, conversions: 0 };
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
