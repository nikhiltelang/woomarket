import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PublicUser } from "@shared/api-types";
import type { Subscription } from "@shared/schema";
import { hasPermission } from "@shared/roles";
import { ApiError, apiRequest, queryClient, setCsrfToken } from "@/lib/api";

interface MeResponse {
  user: PublicUser;
  subscription: Subscription | null;
}

interface LoginResponse {
  user: PublicUser;
  csrfToken: string;
  redirect: string;
}

interface AuthValue {
  user: PublicUser | null;
  subscription: Subscription | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<LoginResponse>;
  signup: (input: Record<string, unknown>) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  can: (...permissions: string[]) => boolean;
  refresh: () => void;
}

const AuthCtx = createContext<AuthValue | null>(null);
export const ME_KEY = ["/api/auth/me"];

export function AuthProvider({ children }: { children: ReactNode }) {
  const me = useQuery<MeResponse | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await apiRequest<MeResponse>("GET", "/api/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const onAuthenticated = async (res: LoginResponse) => {
    setCsrfToken(res.csrfToken);
    queryClient.clear();
    await queryClient.fetchQuery({ queryKey: ME_KEY });
    return res;
  };

  const loginMutation = useMutation({
    mutationFn: (v: { username: string; password: string }) => apiRequest<LoginResponse>("POST", "/api/auth/login", v),
    onSuccess: onAuthenticated,
  });
  const signupMutation = useMutation({
    mutationFn: (v: Record<string, unknown>) => apiRequest<LoginResponse>("POST", "/api/auth/signup", v),
    onSuccess: onAuthenticated,
  });

  const user = me.data?.user ?? null;
  const value: AuthValue = {
    user,
    subscription: me.data?.subscription ?? null,
    isLoading: me.isLoading,
    login: (username, password) => loginMutation.mutateAsync({ username, password }),
    signup: (input) => signupMutation.mutateAsync(input),
    logout: async () => {
      await apiRequest("POST", "/api/auth/logout").catch(() => {});
      setCsrfToken(null);
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
    can: (...permissions) => hasPermission(user?.permissions, ...permissions),
    refresh: () => void me.refetch(),
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
