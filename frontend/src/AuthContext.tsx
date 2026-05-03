import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { api, onAuthError } from './api';

interface AuthContextType {
  authenticated: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(true);

  const handleAuthError = useCallback(() => {
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    onAuthError(handleAuthError);
  }, [handleAuthError]);

  const login = async (password: string) => {
    await api.login(password);
    setAuthenticated(true);
  };

  const logout = () => {
    api.logout().catch(() => {});
    setAuthenticated(false);
  };

  return (
    <AuthContext.Provider value={{ authenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
