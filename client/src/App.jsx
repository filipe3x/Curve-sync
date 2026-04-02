import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/layout/Shell';
import DashboardPage from './pages/DashboardPage';
import ExpensesPage from './pages/ExpensesPage';
import CurveConfigPage from './pages/CurveConfigPage';
import CurveLogsPage from './pages/CurveLogsPage';

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/curve/config" element={<CurveConfigPage />} />
        <Route path="/curve/logs" element={<CurveLogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
