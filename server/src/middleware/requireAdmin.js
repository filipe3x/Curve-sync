import User from '../models/User.js';
import { audit, clientIp } from '../services/audit.js';

/**
 * Express middleware: gates a route behind the admin role.
 *
 * Assumes `authenticate` has already run and populated `req.userId`.
 * Looks up the user, checks `role === 'admin'`, and:
 *   - 401 if the session points at a row that no longer exists (should
 *     never happen in practice — lazy cleanup in `authenticate` deletes
 *     expired sessions, but `users` rows can be deleted by Embers)
 *   - 403 + `admin_access_failed` audit row if the user is not an admin
 *   - `next()` otherwise
 *
 * The audit action name is `admin_access_failed` (not `admin_denied`)
 * to satisfy the `audit.js` heuristic that flips `status: 'error'` on
 * any action `includes('failed')`. See docs/Categories.md §13.7 #2 for
 * the rename justification.
 *
 * Caches nothing — the role lookup is a single indexed find by _id on
 * a shared collection. If this ever becomes a hot path, cache the role
 * on req.userId inside `authenticate` instead of short-circuiting here.
 */
export async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('role').lean();
    if (!user) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }
    if (user.role !== 'admin') {
      audit({
        action: 'admin_access_failed',
        userId: req.userId,
        ip: clientIp(req),
        detail: `method=${req.method} path=${req.originalUrl}`,
      });
      return res.status(403).json({ error: 'admin_required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
