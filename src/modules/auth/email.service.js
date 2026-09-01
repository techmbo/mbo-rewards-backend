import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const DEFAULT_FROM = "MBO Rewards <noreply@mborewards.com>";

function getFromAddress() {
  return process.env.EMAIL_FROM || DEFAULT_FROM;
}

function resolveProvider() {
  if (process.env.RESEND_API_KEY) {
    return "resend";
  }
  if (process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return "ses";
  }
  if (process.env.NODE_ENV !== "production") {
    return "console";
  }
  return null;
}

function buildOtpEmailContent(otp) {
  const subject = "Your MBO Rewards verification code";
  const text = `Your verification code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #0d1b3e;">
      <p>Your verification code is:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.3em; margin: 16px 0;">${otp}</p>
      <p style="color: #64748b; font-size: 14px;">This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>
    </div>
  `;
  return { subject, text, html };
}

async function sendViaResend({ to, subject, text, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: getFromAddress(),
      to: [to],
      subject,
      text,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Failed to send email via Resend.");
  }
}

async function sendViaSes({ to, subject, text, html }) {
  const client = new SESClient({
    region: process.env.AWS_SES_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  await client.send(
    new SendEmailCommand({
      Source: getFromAddress(),
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: text, Charset: "UTF-8" },
          Html: { Data: html, Charset: "UTF-8" },
        },
      },
    }),
  );
}

async function sendViaConsole({ to, otp }) {
  // eslint-disable-next-line no-console
  console.log(`[dev-email] OTP for ${to}: ${otp}`);
}

export async function sendOtpEmail({ to, otp }) {
  const provider = resolveProvider();
  if (!provider) {
    const error = new Error("Email delivery is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const { subject, text, html } = buildOtpEmailContent(otp);

  if (provider === "resend") {
    await sendViaResend({ to, subject, text, html });
    return;
  }

  if (provider === "ses") {
    await sendViaSes({ to, subject, text, html });
    return;
  }

  await sendViaConsole({ to, otp });
}
