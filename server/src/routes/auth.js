import { Router } from 'express';
import User from '../models/User.js';
import Session from '../models/Session.js';
import { verifyPassword, generateToken } from '../services/auth.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password são obrigatórios.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).lean();
    if (!user || !verifyPassword(password, user.salt, user.encrypted_password)) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = generateToken();
    await Session.create({ user_id: user._id, token });

    res.json({
      token,
      user: { id: user._id, email: user.email, role: user.role },
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
