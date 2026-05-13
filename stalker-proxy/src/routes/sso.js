const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;

function createSSORouter(deps) {
  const { auth } = deps;
  const router = express.Router();
  const APP_URL = process.env.APP_URL || "http://localhost:5173";
  const CALLBACK_BASE = process.env.OAUTH_CALLBACK_URL_BASE || "http://localhost:3001";

  const cookieOptions = {
    httpOnly: true,
    secure: APP_URL.startsWith("https") || process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  };

  async function handleOAuthCallback(req, provider, subjectRaw, displayName, email, done) {
    const subject = String(subjectRaw);
    try {
      const token = req.cookies?.sv_auth || (req.headers.authorization ? req.headers.authorization.slice(7) : null);
      if (token) {
        try {
          const user = auth.verifyToken(token);
          if (user) {
            const linkedUser = auth.getFederatedCredential(provider, subject);
            if (linkedUser && linkedUser.id !== user.id) return done(null, false, { message: `already_linked` });
            if (!linkedUser) auth.linkFederatedCredential(user.id, provider, subject);
            return done(null, user, { message: 'linked' });
          }
        } catch (e) { console.error(`[SSO Linking Error for ${provider}]`, e); }
      }
      const linkedUser = auth.getFederatedCredential(provider, subject);
      if (linkedUser) return done(null, linkedUser);
      try {
        const baseUsername = displayName ? displayName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : `${provider}user`;
        const newUser = await auth.createFederatedUser(baseUsername + Math.floor(Math.random()*10000), email, provider, subject);
        return done(null, newUser);
      } catch (err) {
        if (err.message === "Email already registered") return done(null, false, { message: `email_exists:${provider}` });
        throw err;
      }
    } catch (err) { return done(err); }
  }

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${CALLBACK_BASE}/api/auth/google/callback`, passReqToCallback: true
    }, (req, at, rt, profile, done) => {
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
      handleOAuthCallback(req, 'google', profile.id, profile.displayName, email, done);
    }));
    router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
    router.get('/auth/google/callback', (req, res, next) => {
      passport.authenticate('google', { session: false }, (err, user, info) => {
        if (err) return res.redirect(`${APP_URL}?error=sso_failed`);
        if (!user) return res.redirect(`${APP_URL}?error=${info?.message?.startsWith('email_exists') ? info.message : (info?.message === 'already_linked' ? 'already_linked' : 'sso_failed')}`);
        res.cookie("sv_auth", auth.generateSSOToken(user.id), cookieOptions);
        res.redirect(`${APP_URL}`);
      })(req, res, next);
    });
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: `${CALLBACK_BASE}/api/auth/github/callback`, scope: ['user:email'], passReqToCallback: true
    }, (req, at, rt, profile, done) => {
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
      handleOAuthCallback(req, 'github', profile.id, profile.displayName || profile.username, email, done);
    }));
    router.get('/auth/github', passport.authenticate('github', { scope: ['user:email'], session: false }));
    router.get('/auth/github/callback', (req, res, next) => {
      passport.authenticate('github', { session: false }, (err, user, info) => {
        if (err) return res.redirect(`${APP_URL}?error=sso_failed`);
        if (!user) return res.redirect(`${APP_URL}?error=${info?.message?.startsWith('email_exists') ? info.message : (info?.message === 'already_linked' ? 'already_linked' : 'sso_failed')}`);
        res.cookie("sv_auth", auth.generateSSOToken(user.id), cookieOptions);
        res.redirect(`${APP_URL}`);
      })(req, res, next);
    });
  }

  return router;
}

module.exports = { createSSORouter };