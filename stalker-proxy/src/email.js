// Email module — Resend API for transactional emails
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.SMTP_FROM || "StreamVault <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "https://streamvault.hopto.org";

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("Email: RESEND_API_KEY not set, skipping email to", to);
    return false;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
    return true;
  } catch (e) {
    console.error("Email send error:", e.message);
    return false;
  }
}

function sendActivation(to, username, token) {
  const link = `${APP_URL}?action=activate&token=${token}`;
  return sendEmail(to, "Activate your StreamVault account", `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
      <h2 style="color:#00d4ff;margin-bottom:4px">StreamVault</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>Welcome! Click the button below to activate your account:</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#00d4ff;color:#000;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
          Activate Account
        </a>
      </p>
      <p style="font-size:13px;color:#888">Or copy this link: <br/>${link}</p>
      <p style="font-size:12px;color:#666">This link expires in 24 hours.</p>
    </div>
  `);
}

function sendPasswordReset(to, username, token) {
  const link = `${APP_URL}?action=reset-password&token=${token}`;
  return sendEmail(to, "Reset your StreamVault password", `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
      <h2 style="color:#00d4ff;margin-bottom:4px">StreamVault</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>You requested a password reset. Click below to set a new password:</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${link}" style="background:#00d4ff;color:#000;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
          Reset Password
        </a>
      </p>
      <p style="font-size:13px;color:#888">Or copy this link: <br/>${link}</p>
      <p style="font-size:12px;color:#666">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    </div>
  `);
}

function sendLoginOTP(to, username, code) {
  return sendEmail(to, `${code} — StreamVault login code`, `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
      <h2 style="color:#00d4ff;margin-bottom:4px">StreamVault</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>Your login verification code is:</p>
      <p style="text-align:center;margin:20px 0;font-size:32px;letter-spacing:8px;font-weight:700;color:#00d4ff">${code}</p>
      <p style="font-size:12px;color:#666">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>
  `);
}

module.exports = { sendEmail, sendActivation, sendPasswordReset, sendLoginOTP, APP_URL };
