import nodemailer from "nodemailer";

const APP_NAME = "Detect outdated documentation using product signals";

function buildEmail(row) {
  const recipients = row.owners.map((owner) => owner.email).join(",");
  const ownerName = row.owners.map((owner) => owner.name).join(" and ");
  const subject = `Review needed: ${row.doc_title}`;
  const signalLines = row.signals_detected.map((signal) => `- ${signal}`).join("\n");
  const changelogLine = row.optional_changelog_reference
    ? `\nSupporting changelog signal: ${row.optional_changelog_reference}\n`
    : "\n";

  const text = `Hi ${ownerName},

${row.doc_title} has been flagged for documentation drift review.

Product area: ${row.product_area}
Doc type: ${row.doc_type}
Last updated: ${row.last_updated}
Confidence: ${row.confidence}
Priority: ${row.priority}

Reason flagged:
${row.reason_flagged}

Signals detected:
${signalLines}${changelogLine}
Open document: ${row.doc_url}

Please review the page, confirm whether it is out of sync with the product, and update the status when you are done.

— ${APP_NAME}`;

  return { recipients, subject, text };
}

function createTransport() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || "465");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error(
      "Email sending is not configured. Add SMTP_USER and SMTP_PASS in Launch environment variables."
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).send({ error: "Method not allowed" });
    return;
  }

  try {
    const body =
      typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const row = body.row;

    if (!row?.doc_title || !Array.isArray(row?.owners) || row.owners.length === 0) {
      response.status(400).send({ error: "Invalid email payload." });
      return;
    }

    const transporter = createTransport();
    const sender = process.env.SEND_FROM || process.env.SMTP_USER;
    const { recipients, subject, text } = buildEmail(row);

    await transporter.sendMail({
      from: sender,
      to: recipients,
      subject,
      text,
    });

    response.status(200).send({ ok: true });
  } catch (error) {
    response.status(500).send({
      error: error instanceof Error ? error.message : "Unable to send email.",
    });
  }
}
