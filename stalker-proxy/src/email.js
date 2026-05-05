// Email module — Resend API for transactional emails
const { Resend } = require("resend");

const APP_URL = process.env.APP_URL || "https://streamvault.hopto.org";
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.SMTP_FROM || "onboarding@resend.dev";
const FROM_NAME = process.env.SMTP_FROM_NAME || "Portal Heaven";

let resend = RESEND_KEY ? new Resend(RESEND_KEY) : null;

function setResend(instance) {
  resend = instance;
}

function escapeHtml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.warn("Email: RESEND_API_KEY not set, skipping email to", to);
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: subject,
      html: html
    });

    if (error) {
      console.error("Resend API error:", error);
      return false;
    }
    console.log(`Email sent successfully to ${to}, ID: ${data.id}`);
    return true;
  } catch (e) {
    console.error("Email send error:", e.message);
    return false;
  }
}

async function sendVerificationEmail(email, token, user) {
  const link = `${APP_URL}?action=activate&token=${token}`;
  return sendEmail({
    to: email,
    subject: "Activate your Portal Heaven account",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
        <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
        <p>Hi <strong>${escapeHtml(user.username)}</strong>,</p>
        <p>Welcome! Click the button below to activate your account:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${link}" style="background:#00d4ff;color:#000;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
            Activate Account
          </a>
        </p>
        <p style="font-size:13px;color:#888">Or copy this link: <br/>${link}</p>
        <p style="font-size:12px;color:#666">This link expires in 24 hours.</p>
      </div>
    `
  });
}

async function sendPasswordResetEmail(email, token, user) {
  const link = `${APP_URL}?action=reset-password&token=${token}`;
  return sendEmail({
    to: email,
    subject: "Reset your Portal Heaven password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
        <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
        <p>Hi <strong>${escapeHtml(user.username)}</strong>,</p>
        <p>You requested a password reset. Click below to set a new password:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${link}" style="background:#00d4ff;color:#000;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">
            Reset Password
          </a>
        </p>
        <p style="font-size:13px;color:#888">Or copy this link: <br/>${link}</p>
        <p style="font-size:12px;color:#666">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `
  });
}

// For backward compatibility and other use cases
async function sendActivation(to, username, token) {
  return sendVerificationEmail(to, token, { username });
}

async function sendPasswordReset(to, username, token) {
  return sendPasswordResetEmail(to, token, { username });
}

async function sendLoginOTP(to, username, code) {
  return sendEmail({
    to: to,
    subject: `${code} — Portal Heaven login code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
        <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
        <p>Hi <strong>${escapeHtml(username)}</strong>,</p>
        <p>Your login verification code is:</p>
        <p style="text-align:center;margin:20px 0;font-size:32px;letter-spacing:8px;font-weight:700;color:#00d4ff">${code}</p>
        <p style="font-size:12px;color:#666">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendActivation,
  sendPasswordReset,
  sendLoginOTP,
  setResend,
  APP_URL
};
