import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthCompletePage, LoginPage } from "./pages/LoginPage";
import { ProjectPage, ProjectsPage } from "./pages/ProjectsPage";

function AppRoutes() {
  const { user } = useAuth();
  if (!user) {
    return (
      <Routes>
        <Route path="/auth/complete" element={<AuthCompletePage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects/:projectId" element={<ProjectPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Hash routing: works on file:// where no server can rewrite paths. */
export function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AuthProvider>
  );
}
