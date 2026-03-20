import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";
import {
  authenticate,
  requireAdminOrBasic,
  AuthRequest,
  ROLES,
} from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// ── GET /track/links/mine — Affiliate Manager gets their own links ─────────────
router.get("/links/mine", authenticate, async (req: AuthRequest, res) => {
  try {
    const links = await prisma.link.findMany({
      where: { affiliateId: req.user!.userId },
      include: {
        offer: {
          select: {
            name: true,
            category: true,
            regPayout: true,
            minDeposit: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(
      links.map((l) => ({
        ...l,
        trackingUrl: buildTrackingUrl(l.id, l.subId),
      })),
    );
  } catch {
    res.status(500).json({ error: "Failed to fetch links" });
  }
});

// ── POST /track/links — Admin distributes OR creates Test Link ─────────────────
router.post(
  "/links",
  authenticate,
  requireAdminOrBasic,
  async (req: AuthRequest, res) => {
    try {
      const { offerId, affiliateId, name, subId } = req.body;

      const targetUserId = affiliateId || req.user!.userId;
      const target = await prisma.user.findUnique({
        where: { id: targetUserId },
      });

      if (!target)
        return res.status(404).json({ error: "Target user not found" });

      if (affiliateId && affiliateId !== req.user!.userId) {
        if (
          req.user!.role === ROLES.BASIC &&
          target.supervisorId !== req.user!.userId
        ) {
          return res.status(403).json({
            error: "You can only assign links to your own team members",
          });
        }
      }

      const offer = await prisma.offer.findUnique({ where: { id: offerId } });
      if (!offer || offer.status !== "ACTIVE")
        return res.status(404).json({ error: "Offer not found or inactive" });

      const link = await prisma.link.create({
        data: {
          name: name ?? `${offer.name} – ${target.username}`,
          casinoUrl: offer.casinoUrl ?? "",
          subId,
          offerId,
          affiliateId: targetUserId,
        },
      });

      res
        .status(201)
        .json({ ...link, trackingUrl: buildTrackingUrl(link.id, link.subId) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create link" });
    }
  },
);

// ── GET /track/:linkId — Public click tracker + redirect ──────────────────────
router.get("/:linkId", async (req, res) => {
  try {
    const link = await prisma.link.findUnique({
      where: { id: req.params.linkId },
      include: { offer: { select: { status: true } } },
    });

    if (!link || link.offer?.status !== "ACTIVE")
      return res.status(404).send("Link not found");

    // 1. Extract IP & Country (IMPROVED for Proxies & IPv6)
    const rawIp =
      (req.headers["x-forwarded-for"] as string) ||
      (req.headers["x-real-ip"] as string) ||
      req.ip ||
      req.socket.remoteAddress ||
      "127.0.0.1";

    // Clean IP: Handle comma-separated lists from proxies and remove IPv6 mapped IPv4 prefixes
    const cleanIp = rawIp
      .split(",")[0]
      .trim()
      .replace(/^::ffff:/, "");

    const geo = geoip.lookup(cleanIp);
    let country =
      geo?.country || (req.headers["cf-ipcountry"] as string) || "Unknown";

    // Fallback for local testing
    if (cleanIp === "127.0.0.1" || cleanIp === "::1") {
      country = "Local";
    }

    // 2. Extract Device & OS
    const userAgent = req.headers["user-agent"] || "";
    const parser = new UAParser(userAgent);
    const device = parser.getDevice();
    const os = parser.getOS();

    const deviceType =
      device.type === "mobile"
        ? "Mobile"
        : device.type === "tablet"
          ? "Tablet"
          : "Desktop";
    const osName = os.name || "Unknown";

    // 3. Create the rich click record
    const click = await prisma.click.create({
      data: {
        linkId: link.id,
        ipAddress: cleanIp,
        userAgent,
        country,
        deviceType,
        os: osName,
      },
    });

    // 4. Construct the outgoing Casino URL safely
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(link.casinoUrl);
    } catch (e) {
      // Fallback if the admin forgot https://
      redirectUrl = new URL(`https://${link.casinoUrl}`);
    }

    // ALWAYS attach the internal click.id so postbacks work!
    redirectUrl.searchParams.set("subid", click.id);

    // If the Admin or Manager assigned a static subId to this link, append it to the casino URL
    if (link.subId) {
      redirectUrl.searchParams.set("aff_sub", link.subId);
    }

    // Capture ANY dynamic parameters the affiliate added to their tracking link
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") {
        redirectUrl.searchParams.set(key, value);
      }
    }

    res.redirect(302, redirectUrl.toString());
  } catch {
    res.status(500).send("Error processing link");
  }
});

// ── POST /track/postback ───────────────────────────────────────────────────────
router.post("/postback", async (req, res) => {
  if (req.headers["x-postback-secret"] !== process.env.POSTBACK_SECRET)
    return res.status(401).json({ error: "Invalid postback secret" });

  const { clickId, amount, currency = "USD" } = req.body;

  if (!clickId || typeof amount !== "number" || amount <= 0)
    return res
      .status(400)
      .json({ error: "clickId and a positive numeric amount are required" });

  try {
    const click = await prisma.click.findUnique({
      where: { id: clickId },
      include: {
        link: {
          include: {
            offer: { select: { status: true, commissionPct: true } },
          },
        },
      },
    });

    if (!click || !click.link || click.link.offer?.status !== "ACTIVE")
      return res.status(404).json({ error: "Click, Link, or Offer not found" });

    const link = click.link;

    const manager = await prisma.user.findUnique({
      where: { id: link.affiliateId },
      select: { id: true, role: true, supervisorId: true },
    });

    if (!manager)
      return res
        .status(400)
        .json({ error: "Link is not assigned to a valid user" });

    const managerAmt = amount;
    const pct = link.offer.commissionPct ?? 10;
    const basicSubAmt = round2(amount * (pct / 100));

    const result = await prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.create({
        data: {
          linkId: link.id,
          amount,
          currency,
          status: "PENDING",
          subId: clickId,
        },
      });

      await tx.commission.create({
        data: {
          depositId: deposit.id,
          recipientId: manager.id,
          amount: managerAmt,
          percentage: 100,
          status: "PENDING",
        },
      });
      await tx.userProfile.update({
        where: { userId: manager.id },
        data: { pendingBalance: { increment: managerAmt } },
      });

      let basicSubCommission = 0;

      if (manager.supervisorId) {
        const basicSub = await tx.user.findUnique({
          where: { id: manager.supervisorId },
          select: { id: true, role: true },
        });

        if (basicSub?.role === ROLES.BASIC) {
          await tx.commission.create({
            data: {
              depositId: deposit.id,
              recipientId: basicSub.id,
              amount: basicSubAmt,
              percentage: pct,
              status: "PENDING",
            },
          });
          await tx.userProfile.update({
            where: { userId: basicSub.id },
            data: { pendingBalance: { increment: basicSubAmt } },
          });
          basicSubCommission = basicSubAmt;
        }
      }

      return { depositId: deposit.id, managerAmt, basicSubCommission };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Postback error:", err);
    res.status(500).json({ error: "Postback processing failed" });
  }
});

function buildTrackingUrl(linkId: string, subId?: string | null) {
  const base = `${process.env.TRACKING_BASE_URL ?? "http://localhost:5001"}/api/track/${linkId}`;
  return subId ? `${base}?sub1=${encodeURIComponent(subId)}` : base;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export default router;
