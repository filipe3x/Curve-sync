import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import Shell from './components/layout/Shell';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ExpensesPage from './pages/ExpensesPage';
import CurveConfigPage from './pages/CurveConfigPage';
import CurveLogsPage from './pages/CurveLogsPage';
import CurveSetupPage from './pages/CurveSetupPage';

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      {/*
        The OAuth setup wizard lives OUTSIDE the Shell layout — no
        sidebar, no header, full-bleed canvas. It's still auth-gated
        so we can pin the state machine to req.userId.
      */}
      <Route
        path="/curve/setup/*"
        element={
          <ProtectedRoute>
            <CurveSetupPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="*"
        element={
          <ProtectedRoute>
            <Shell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/expenses" element={<ExpensesPage />} />
                <Route path="/curve/config" element={<CurveConfigPage />} />
                <Route path="/curve/logs" element={<CurveLogsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Shell>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
