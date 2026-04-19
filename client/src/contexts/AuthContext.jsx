import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });

  const login = useCallback((tokenValue, userData) => {
    localStorage.setItem('token', tokenValue);
    localStorage.setItem('user', JSON.stringify(userData));
    setToken(tokenValue);
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  }, []);

  // Listen for 401 events dispatched by api.js
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, [logout]);

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
