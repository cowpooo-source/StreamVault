const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const auth = require("../auth");

const router = express.Router();
const APP_URL = process.env.APP_URL || "http://localhost:5173";
const CALLBACK_BASE = process.env.OAUTH_CALLBACK_URL_BASE || "http://localhost:3001";

// Cookie options for JWT
const cookieOptions = {
  httpOnly: true,
  secure: APP_URL.startsWith("https"),
  sameSite: APP_URL.startsWith("https") ? "none" : "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// ── Passport Configuration ──

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${CALLBACK_BASE}/api/auth/google/callback`,
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
      return handleOAuthCallback(req, 'google', profile.id, profile.displayName, email, done);
    } catch (err) {
      return done(err);
    }
  }));
}

// Facebook Strategy
if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: `${CALLBACK_BASE}/api/auth/facebook/callback`,
    profileFields: ['id', 'displayName', 'emails'],
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails.length > 0 ? profile.emails[0].value : null;
      return handleOAuthCallback(req, 'facebook', profile.id, profile.displayName, email, done);
    } catch (err) {
      return done(err);
    }
  }));
}

// Common OAuth Handler
async function handleOAuthCallback(req, provider, subject, displayName, email, done) {
  try {
    // Check if identity already linked
    const linkedUser = auth.getFederatedCredential(provider, subject);
    if (linkedUser) {
      return done(null, linkedUser);
    }

    // New SSO login. Do we have an email match?
    if (email) {
      // We must use the db directly or a helper method to find user by email
      const db = require("../auth")._db; // Hacky, better to use a helper. 
      // Actually, we need to check if user exists.
      // Wait, let's use a prepared statement or helper. We'll add getUserByEmail to exports if it's not there, but it's not exported.
      // Let's use listUsers or add a helper. For now, let's assume we can fetch all users and filter, or we just try to create and catch error.
      // Better: we can try to createFederatedUser. If it throws "Email already registered", we catch it.
    }
    
    // Attempt to create. If email exists, it throws.
    try {
      // Generate a base username from display name
      const baseUsername = displayName ? displayName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : `${provider}user`;
      let username = baseUsername;
      
      // We need a unique username. If create throws username taken, we retry.
      // This is a simplified approach.
      const newUser = await auth.createFederatedUser(username + Math.floor(Math.random()*10000), email, provider, subject);
      return done(null, newUser);

    } catch (err) {
      if (err.message === "Email already registered") {
        // Trigger Prompt to Link
        return done(null, false, { message: `email_exists:${provider}` });
      }
      throw err;
    }

  } catch (err) {
    return done(err);
  }
}

// ── Routes ──

// Google
router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err) return res.redirect(`${APP_URL}?error=sso_failed`);
    if (!user) {
      if (info && info.message && info.message.startsWith('email_exists')) {
        const provider = info.message.split(':')[1];
        return res.redirect(`${APP_URL}?error=email_exists&provider=${provider}`);
      }
      return res.redirect(`${APP_URL}?error=sso_failed`);
    }
    
    // Generate JWT and set cookie
    const token = auth.generateSSOToken(user.id);
    res.cookie("sv_auth", token, cookieOptions);
    res.redirect(`${APP_URL}`);
  })(req, res, next);
});

// Facebook
router.get('/auth/facebook', passport.authenticate('facebook', { scope: ['email'], session: false }));
router.get('/auth/facebook/callback', (req, res, next) => {
  passport.authenticate('facebook', { session: false }, (err, user, info) => {
    if (err) return res.redirect(`${APP_URL}?error=sso_failed`);
    if (!user) {
      if (info && info.message && info.message.startsWith('email_exists')) {
        const provider = info.message.split(':')[1];
        return res.redirect(`${APP_URL}?error=email_exists&provider=${provider}`);
      }
      return res.redirect(`${APP_URL}?error=sso_failed`);
    }
    
    // Generate JWT and set cookie
    const token = auth.generateSSOToken(user.id);
    res.cookie("sv_auth", token, cookieOptions);
    res.redirect(`${APP_URL}`);
  })(req, res, next);
});

module.exports = router;
