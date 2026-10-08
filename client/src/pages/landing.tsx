import { useEffect } from "react";
import { Redirect } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { LandingPage } from "@shared/landing";
import { useAuth } from "@/contexts/auth";
import { usePlatform } from "@/contexts/platform";
import { PageLoader } from "@/components/ui/display";
import { LandingView, type LandingPlan } from "@/components/landing";

type Response = { data: LandingPage | { enabled: false }; plans?: LandingPlan[] };

/**
 * "/": the public landing page for visitors when the superadmin has turned it on; otherwise
 * sign-in. Signed-in users go to their dashboard. "/home" (`always`) shows the page to anyone.
 */
export default function LandingRoute({ always = false }: { always?: boolean }) {
  const { user, isLoading } = useAuth();
  const { config } = usePlatform();
  // White-label domains skip the platform's marketing page.
  const branded = Boolean(config?.brand?.onBrandDomain);
  const q = useQuery<Response>({ queryKey: ["/api/landing-page"], enabled: !branded && (always || (!isLoading && !user)), staleTime: 60_000 });
  const page = q.data?.data;
  useEffect(() => {
    if (page?.enabled && config?.siteTitle) document.title = config.siteTitle;
  }, [page?.enabled, config?.siteTitle]);

  const home = user?.role === "superadmin" ? "/admin" : "/dashboard";
  if (isLoading) return <PageLoader />;
  if (branded) return <Redirect to={user ? home : "/login"} />;
  if (user && !always) return <Redirect to={home} />;
  if (q.isLoading) return <PageLoader />;
  if (!page?.enabled) return <Redirect to={user ? home : "/login"} />;
  return <LandingView page={page} plans={q.data?.plans ?? []} />;
}
