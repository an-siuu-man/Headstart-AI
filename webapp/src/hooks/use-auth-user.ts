"use client"

import { useEffect, useState } from "react";

export type AuthUserSummary = {
  id: string;
  email: string;
  displayName: string;
};

export function useAuthUser() {
  const [user, setUser] = useState<AuthUserSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadUser() {
      try {
        const response = await fetch("/api/auth/me", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });

        if (!response.ok) {
          if (!isMounted) return;
          setUser(null);
          return;
        }

        const body = (await response.json()) as {
          user?: {
            id?: string;
            email?: string;
            display_name?: string;
          };
        };

        const nextUser = body.user;
        if (!nextUser?.id) {
          if (!isMounted) return;
          setUser(null);
          return;
        }

        if (!isMounted) return;

        setUser({
          id: nextUser.id,
          email: nextUser.email ?? "",
          displayName: nextUser.display_name ?? nextUser.email ?? "Student",
        });
      } catch {
        if (!isMounted) return;
        setUser(null);
      } finally {
        if (!isMounted) return;
        setIsLoading(false);
      }
    }

    void loadUser();

    return () => {
      isMounted = false;
    };
  }, []);

  return {
    user,
    isLoading,
  };
}
