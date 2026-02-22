const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.LEAD_RATE_LIMIT_MAX || 8);

const rateStore = globalThis.__FENCE_LEAD_RATE_STORE || new Map();
globalThis.__FENCE_LEAD_RATE_STORE = rateStore;

class PublicError extends Error {
  constructor(statusCode, publicMessage, details) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.details = details || "";
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(res, 204, { ok: true });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!isAllowedOrigin(req)) {
      return sendJson(res, 400, { ok: false, error: "Origin not allowed" });
    }

    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: "Too many requests. Try again later." });
    }

    const input = parseBody(req.body);
    if (!input) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    }

    const lead = normalizeLead(input);
    const validationError = validateLead(lead);
    if (validationError) {
      return sendJson(res, 400, { ok: false, error: validationError });
    }

    const apiKey = String(process.env.SENDGRID_API_KEY || "").trim();
    const fromEmail = String(process.env.FROM_EMAIL || "").trim();

    if (!apiKey || !fromEmail) {
      return sendJson(res, 500, { ok: false, error: "Email service is not configured." });
    }
    if (!isValidEmail(fromEmail)) {
      return sendJson(res, 500, { ok: false, error: "FROM_EMAIL is invalid." });
    }

    const ownerSubject = `New Fence Lead – ${formatFeet(lead.totalLinearFeet)} ft – ${formatUsd(lead.estimatedMin)}-${formatUsd(
      lead.estimatedMax
    )}`;

    const ownerHtml = buildOwnerHtml(lead);
    const ownerText = buildOwnerText(lead);

    await sendSendGridEmail({
      apiKey,
      fromEmail,
      toEmail: lead.pushover_email,
      subject: ownerSubject,
      html: ownerHtml,
      text: ownerText,
      replyTo: lead.email,
    });

    const customerSubject = "We received your fence quote request";
    const customerHtml = buildCustomerHtml(lead);
    const customerText = buildCustomerText(lead);

    await sendSendGridEmail({
      apiKey,
      fromEmail,
      toEmail: lead.email,
      subject: customerSubject,
      html: customerHtml,
      text: customerText,
      replyTo: lead.pushover_email,
    });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof PublicError) {
      console.error("/api/lead public error", { message: err.publicMessage, details: err.details });
      return sendJson(res, err.statusCode, { ok: false, error: err.publicMessage });
    }
    console.error("/api/lead error", err);
    return sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
};

function parseBody(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeLead(input) {
  return {
    client: cleanText(input.client, 64),
    companyName: cleanText(input.companyName, 120),
    pushover_email: cleanEmail(input.pushover_email),
    address: cleanText(input.address, 220),
    fenceType: cleanText(input.fenceType, 64),
    walkGatesQty: toNonNegativeInt(input.walkGatesQty),
    doubleGatesQty: toNonNegativeInt(input.doubleGatesQty),
    removeOldFence: Boolean(input.removeOldFence),
    totalLinearFeet: toPositiveNumber(input.totalLinearFeet),
    segmentsCount: toNonNegativeInt(input.segmentsCount),
    estimatedMin: toNonNegativeNumber(input.estimatedMin),
    estimatedMax: toNonNegativeNumber(input.estimatedMax),
    segments: normalizeSegments(input.segments),
    fullName: cleanText(input.fullName, 120),
    phone: cleanText(input.phone, 40),
    email: cleanEmail(input.email),
    created_at: cleanText(input.created_at, 80),
    page_url: cleanText(input.page_url, 300),
    website: cleanText(input.website, 200),
  };
}

function validateLead(lead) {
  if (lead.website) return "Spam blocked.";
  if (!lead.fullName) return "Full name is required.";
  if (!lead.phone) return "Phone is required.";
  if (!isValidEmail(lead.email)) return "Valid customer email is required.";
  if (!lead.address) return "Address is required.";
  if (!isValidEmail(lead.pushover_email)) return "Valid owner email is required.";
  if (!(lead.totalLinearFeet > 0)) return "totalLinearFeet must be greater than 0.";
  return "";
}

function isAllowedOrigin(req) {
  const allowedRaw = String(process.env.ALLOWED_ORIGINS || "").trim();
  if (!allowedRaw) return true;

  const originHeader = String(req.headers.origin || "").trim();
  if (!originHeader) return false;

  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;

  const allowed = allowedRaw
    .split(",")
    .map((item) => normalizeOrigin(item.trim()))
    .filter(Boolean);

  return allowed.includes(origin);
}

function normalizeOrigin(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return "";
  }
}

function isRateLimited(ip) {
  const key = ip || "unknown";
  const now = Date.now();

  if (rateStore.size > 1000) {
    for (const [k, rec] of rateStore.entries()) {
      if (now > rec.resetAt) rateStore.delete(k);
    }
  }

  const current = rateStore.get(key);
  if (!current || now > current.resetAt) {
    rateStore.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  current.count += 1;
  rateStore.set(key, current);

  return current.count > RATE_LIMIT_MAX;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp) return realIp;
  return String(req.socket?.remoteAddress || "").trim() || "unknown";
}

async function sendSendGridEmail({ apiKey, fromEmail, toEmail, subject, html, text, replyTo }) {
  const body = {
    personalizations: [{ to: [{ email: toEmail }], subject }],
    from: { email: fromEmail },
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
  };

  if (replyTo && isValidEmail(replyTo)) {
    body.reply_to = { email: replyTo };
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const raw = await response.text();
    const providerDetails = extractSendGridMessage(raw);
    let publicMessage = "Email delivery failed.";

    if (response.status === 401) {
      publicMessage = "SendGrid API key is invalid.";
    } else if (response.status === 403) {
      publicMessage = "Sender email is not verified in SendGrid.";
    } else if (response.status === 400) {
      publicMessage = "SendGrid rejected the email request. Check sender/recipient emails.";
    }

    throw new PublicError(500, publicMessage, `status=${response.status}; details=${providerDetails}`);
  }
}

function extractSendGridMessage(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const first = parsed?.errors?.[0];
    if (first?.message) return String(first.message).slice(0, 400);
  } catch {
    // ignore
  }
  return String(raw).slice(0, 400);
}

function buildOwnerHtml(lead) {
  const range = `${formatUsd(lead.estimatedMin)} - ${formatUsd(lead.estimatedMax)}`;
  const gates = `${lead.walkGatesQty} walk, ${lead.doubleGatesQty} double`;
  const segmentsLine = lead.segmentsCount ? `${lead.segmentsCount}` : "0";

  const segmentsBlock = lead.segments?.length
    ? `<p><strong>Segments Data:</strong></p><pre style="white-space:pre-wrap;font-size:12px;background:#f5f8fa;border:1px solid #d6e3ea;border-radius:8px;padding:10px;">${escapeHtml(
        JSON.stringify(lead.segments)
      )}</pre>`
    : "";

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#102531;line-height:1.45;">
      <h2 style="margin:0 0 12px;">New Fence Lead</h2>
      <p><strong>Customer:</strong> ${escapeHtml(lead.fullName)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p>
      <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
      <p><strong>Address:</strong> ${escapeHtml(lead.address)}</p>
      <hr style="border:none;border-top:1px solid #dbe7ee;margin:14px 0;" />
      <p><strong>Company:</strong> ${escapeHtml(lead.companyName || lead.client || "Fence Widget")}</p>
      <p><strong>Fence type:</strong> ${escapeHtml(lead.fenceType || "N/A")}</p>
      <p><strong>Gates:</strong> ${escapeHtml(gates)}</p>
      <p><strong>Remove old fence:</strong> ${lead.removeOldFence ? "Yes" : "No"}</p>
      <p><strong>Total linear feet:</strong> ${escapeHtml(formatFeet(lead.totalLinearFeet))} ft</p>
      <p><strong>Segments count:</strong> ${escapeHtml(String(segmentsLine))}</p>
      <p><strong>Estimated range:</strong> ${escapeHtml(range)}</p>
      ${segmentsBlock}
      <p style="font-size:12px;color:#5f7480;margin-top:14px;">Submitted at: ${escapeHtml(lead.created_at || new Date().toISOString())}</p>
      <p style="font-size:12px;color:#5f7480;">Page: ${escapeHtml(lead.page_url || "")}</p>
    </div>
  `;
}

function buildOwnerText(lead) {
  const lines = [
    "New Fence Lead",
    "",
    `Customer: ${lead.fullName}`,
    `Phone: ${lead.phone}`,
    `Email: ${lead.email}`,
    `Address: ${lead.address}`,
    "",
    `Company: ${lead.companyName || lead.client || "Fence Widget"}`,
    `Fence type: ${lead.fenceType || "N/A"}`,
    `Walk gates: ${lead.walkGatesQty}`,
    `Double gates: ${lead.doubleGatesQty}`,
    `Remove old fence: ${lead.removeOldFence ? "Yes" : "No"}`,
    `Total feet: ${formatFeet(lead.totalLinearFeet)} ft`,
    `Segments: ${lead.segmentsCount}`,
    `Estimated range: ${formatUsd(lead.estimatedMin)} - ${formatUsd(lead.estimatedMax)}`,
    "",
    `Submitted at: ${lead.created_at || new Date().toISOString()}`,
    `Page: ${lead.page_url || ""}`,
  ];

  return lines.join("\n");
}

function buildCustomerHtml(lead) {
  const range = `${formatUsd(lead.estimatedMin)} - ${formatUsd(lead.estimatedMax)}`;
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#102531;line-height:1.45;">
      <h2 style="margin:0 0 10px;">We received your fence quote request</h2>
      <p>Hi ${escapeHtml(lead.fullName)},</p>
      <p>Thanks for your request. Here is a summary of your estimate:</p>
      <p><strong>Address:</strong> ${escapeHtml(lead.address)}</p>
      <p><strong>Fence type:</strong> ${escapeHtml(lead.fenceType || "N/A")}</p>
      <p><strong>Total linear feet:</strong> ${escapeHtml(formatFeet(lead.totalLinearFeet))} ft</p>
      <p><strong>Estimated range:</strong> ${escapeHtml(range)}</p>
      <p style="margin-top:14px;color:#4f6570;">This is an estimate range. Final pricing will be confirmed by the owner.</p>
    </div>
  `;
}

function buildCustomerText(lead) {
  return [
    "We received your fence quote request",
    "",
    `Address: ${lead.address}`,
    `Fence type: ${lead.fenceType || "N/A"}`,
    `Total linear feet: ${formatFeet(lead.totalLinearFeet)} ft`,
    `Estimated range: ${formatUsd(lead.estimatedMin)} - ${formatUsd(lead.estimatedMax)}`,
    "",
    "This is an estimate range. Final pricing will be confirmed by the owner.",
  ].join("\n");
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function cleanText(value, maxLen) {
  const text = String(value == null ? "" : value)
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();
  return text.slice(0, maxLen);
}

function cleanEmail(value) {
  return cleanText(value, 160).toLowerCase();
}

function normalizeSegments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((segment) => {
    if (!Array.isArray(segment)) return [];
    return segment.slice(0, 200).map((pt) => ({
      lat: toFinite(pt?.lat),
      lng: toFinite(pt?.lng),
    }));
  });
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(7)) : 0;
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toNonNegativeInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function formatFeet(value) {
  return Number(value || 0).toFixed(1);
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
