import Session from '../models/Session.js';

/**
 * Express middleware: validates Bearer token from the Authorization header,
 * looks up the session in MongoDB, and sets req.userId.
 */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token em falta.' });
  }

  const token = header.slice(7);
  try {
    const session = await Session.findOne({ token }).select('user_id').lean();
    if (!session) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    req.userId = session.user_id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
