import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LoginResult, PublicUser } from "@planning/shared";
import { api, setToken, setUnauthorizedHandler } from "../api/client";

interface AuthState {
  user: PublicUser | null;
  signIn(result: LoginResult): void;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** The session exists only in memory: reloading the page asks for login again. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);

  const signIn = useCallback((result: LoginResult) => {
    setToken(result.token);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
