import { Router } from 'express';
import User from '../models/User.js';
import Session from '../models/Session.js';
import {
  verifyPassword,
  hashPassword,
  generateToken,
  SESSION_TTL_MS,
} from '../services/auth.js';
import { authenticate } from '../middleware/auth.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// Embers' email format validator (`models/user.rb:32`). Deliberately
// lax — anything containing an `@` and a `.` passes. We use the exact
// same regex so that any email accepted here is also accepted by the
// Embers validation layer if the user later logs into Embers directly.
const EMAIL_REGEX = /.*@.*\..*/;
const MIN_PASSWORD_LENGTH = 8;

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password são obrigatórios.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).lean();
    if (!user || !verifyPassword(password, user.salt, user.encrypted_password)) {
      // Log failed attempt — use the looked-up user if found, otherwise
      // create a minimal entry. We still want the IP in the audit trail.
      audit({
        action: 'login_failed',
        userId: user?._id ?? '000000000000000000000000',
        ip: clientIp(req),
        detail: `email: ${email.toLowerCase()}`,
      });
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = generateToken();
    const expires_at = new Date(Date.now() + SESSION_TTL_MS);
    await Session.create({ user_id: user._id, token, expires_at });

    audit({ action: 'login', userId: user._id, ip: clientIp(req) });

    res.json({
      token,
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register
//
// Creates a new Embers-compatible user row in the shared `users`
// collection and immediately opens a session (auto-login). The
// resulting record is byte-shape-identical to what Embers' Mongoid
// `User` model would persist, so the same credentials work on the
// Embers app unchanged. See `docs/embers-reference/models/user.rb`
// for the canonical schema and `services/auth.js:hashPassword` for
// the salt + encrypted_password derivation.
//
// Constraints:
//   - email must match Embers' `/.*@.*\..*/` validator (lax on
//     purpose: any email Embers would accept is accepted here)
//   - password ≥ 8 chars + must match password_confirmation
//   - role is forced to `'user'`; admin assignment stays exclusive to
//     Embers (per CLAUDE.md MongoDB Collection Access Rules)
//
// Race-condition note: there is NO unique index on `users.email` in
// the shared MongoDB instance — Embers enforces uniqueness only at
// the application layer via Mongoid's `validates :email, uniqueness:`
// callback (`models/user.rb:31`). Our findOne check below has the
// same race window Embers does, but on the registration cadence of a
// personal-finance app with a 5/hour per-IP rate limit it is
// effectively unreachable. Adding a DB-level unique index would be a
// shared-schema change that needs Embers buy-in — out of scope here.
router.post('/register', async (req, res) => {
  try {
    const { email, password, password_confirmation } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email e password são obrigatórios.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Email inválido.' });
    }

    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `A password tem de ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` });
    }

    if (password_confirmation !== undefined && password_confirmation !== password) {
      return res
        .status(400)
        .json({ error: 'A confirmação da password não coincide.' });
    }

    const existing = await User.findOne({ email: normalizedEmail })
      .select('_id')
      .lean();
    if (existing) {
      // Audit the collision so the trail captures attempts to register
      // an email that's already taken (common shape for credential
      // stuffing reconnaissance). 409 is the right shape semantically;
      // we keep the message generic so we don't expose whether the
      // collision came from Curve Sync or Embers.
      audit({
        action: 'register_failed',
        userId: existing._id,
        ip: clientIp(req),
        detail: `email_taken=${normalizedEmail}`,
      });
      return res
        .status(409)
        .json({ error: 'Já existe uma conta com este email.' });
    }

    const { salt, encrypted_password } = hashPassword(password);
    const now = new Date();
    const created = await User.create({
      email: normalizedEmail,
      salt,
      encrypted_password,
      role: 'user',
      created_at: now,
      updated_at: now,
    });

    // Auto-login: same code path as POST /login, same `generateToken`
    // helper (32 bytes of crypto-random → 64 hex chars), same
    // SESSION_TTL_MS, same `sessions` collection. Reusing the helper
    // means the token entropy story is the login story — there is no
    // second token-minting site to keep in sync.
    const token = generateToken();
    const expires_at = new Date(Date.now() + SESSION_TTL_MS);
    await Session.create({ user_id: created._id, token, expires_at });

    audit({
      action: 'register',
      userId: created._id,
      ip: clientIp(req),
      detail: `email=${normalizedEmail}`,
    });

    res.status(201).json({
      token,
      user: { id: created._id, email: created.email, role: created.role },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization.slice(7);
    await Session.deleteOne({ token });
    audit({ action: 'logout', userId: req.userId, ip: clientIp(req) });
    res.json({ message: 'Sessão terminada.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('email role').lean();
    if (!user) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }
    res.json({ user: { id: user._id, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
