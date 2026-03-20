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

    const cleanIp = rawIp
      .split(",")[0]
      .trim()
      .replace(/^::ffff:/, "");

    const geo = geoip.lookup(cleanIp);
    let country =
      geo?.country || (req.headers["cf-ipcountry"] as string) || "Unknown";

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

    // 4. Construct the outgoing Casino URL safely (MACRO REPLACEMENT)
    let rawUrl = link.casinoUrl;

    // Replace {click_id} and {sub_id} macros if the casino provided them in the link
    rawUrl = rawUrl.replace(/\{click_id\}/gi, click.id);
    rawUrl = rawUrl.replace(/\{sub_id_1\}/gi, link.subId || click.id); // Default to click ID if no subId is assigned
    rawUrl = rawUrl.replace(/\{sub_id\}/gi, link.subId || click.id);

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(rawUrl);
    } catch (e) {
      redirectUrl = new URL(`https://${rawUrl}`);
    }

    // Fallback: If the admin pasted a clean URL WITHOUT macros, append them manually
    if (!link.casinoUrl.includes("{click_id}")) {
      redirectUrl.searchParams.set("click_id", click.id);
    }
    if (link.subId && !link.casinoUrl.includes("{sub_id_1}")) {
      redirectUrl.searchParams.set("sub_id", link.subId);
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

// ── POST & GET /track/postback ────────────────────────────────────────────────
// Consolidated handler to support both standard GET Server-to-Server callbacks and custom POST requests
const processPostback = async (req: any, res: any) => {
  // Check for secret in Headers (POST), Query (GET), or Body (POST)
  const secret =
    req.headers["x-postback-secret"] || req.query.secret || req.body.secret;

  if (secret !== process.env.POSTBACK_SECRET)
    return res.status(401).json({ error: "Invalid postback secret" });

  // Map the parameters from either the query string or body payload
  const clickId =
    req.body.clickId ||
    req.query.click_id ||
    req.query.clickId ||
    req.query.subid;
  const amountRaw = req.body.amount || req.query.amount || req.query.payout;
  const currency = req.body.currency || req.query.currency || "USD";

  const amount = parseFloat(amountRaw);

  if (!clickId || isNaN(amount) || amount <= 0)
    return res
      .status(400)
      .json({ error: "click_id and a positive numeric amount are required" });

  try {
    const click = await prisma.click.findUnique({
      where: { id: clickId as string },
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
          currency: currency as string,
          status: "PENDING",
          subId: clickId as string,
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
};

// Route the unified handler to both methods
router.post("/postback", processPostback);
router.get("/postback", processPostback);

function buildTrackingUrl(linkId: string, subId?: string | null) {
  const base = `${process.env.TRACKING_BASE_URL ?? "http://localhost:5001"}/api/track/${linkId}`;
  return subId ? `${base}?sub1=${encodeURIComponent(subId)}` : base;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export default router;
