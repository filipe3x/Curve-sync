import Session from '../models/Session.js';

/**
 * Express middleware: validates Bearer token from the Authorization header,
 * looks up the session in MongoDB, checks expiry, and sets req.userId.
 * Expired sessions are deleted on the spot (lazy cleanup).
 */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token em falta.' });
  }

  const token = header.slice(7);
  try {
    const session = await Session.findOne({ token })
      .select('user_id expires_at')
      .lean();

    if (!session) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    // Check expiry — sessions without expires_at (Embers legacy) are allowed
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await Session.deleteOne({ token });
      return res.status(401).json({ error: 'Sessão expirada.' });
    }

    req.userId = session.user_id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
