// Email module — Brevo API for transactional emails
const APP_URL = process.env.APP_URL || "https://streamvault.hopto.org";
const BREVO_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.SMTP_FROM || "portalheaven.stream@gmail.com";
const FROM_NAME = process.env.SMTP_FROM_NAME || "Portal Heaven";

function escapeHtml(unsafe) {
  if (!unsafe) return "";
  return String(unsafe).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

async function sendEmail(to, subject, html) {
  if (!BREVO_KEY) {
    console.warn("Email: BREVO_API_KEY not set, skipping email to", to);
    return false;
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: to }],
        subject: subject,
        htmlContent: html
      })
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Brevo API error:", err);
      return false;
    }
    console.log(`Email sent successfully to ${to}`);
    return true;
  } catch (e) {
    console.error("Email send error:", e.message);
    return false;
  }
}

function sendActivation(to, username, token) {
  const link = `${APP_URL}?action=activate&token=${token}`;
  return sendEmail(to, "Activate your Portal Heaven account", `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
      <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
      <p>Hi <strong>${escapeHtml(username)}</strong>,</p>
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
  return sendEmail(to, "Reset your Portal Heaven password", `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
      <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
      <p>Hi <strong>${escapeHtml(username)}</strong>,</p>
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
  return sendEmail(to, `${code} — Portal Heaven login code`, `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;background:#0f0f1c;color:#fff;border-radius:12px">
      <h2 style="color:#00d4ff;margin-bottom:4px">Portal Heaven</h2>
      <p>Hi <strong>${escapeHtml(username)}</strong>,</p>
      <p>Your login verification code is:</p>
      <p style="text-align:center;margin:20px 0;font-size:32px;letter-spacing:8px;font-weight:700;color:#00d4ff">${code}</p>
      <p style="font-size:12px;color:#666">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>
  `);
}

module.exports = { sendEmail, sendActivation, sendPasswordReset, sendLoginOTP, APP_URL };
