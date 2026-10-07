import { useEffect } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import type { PolicyPage } from "@shared/schema";
import { usePlatform } from "@/contexts/platform";
import { Markdown } from "@/lib/markdown";
import { EmptyState, PageLoader } from "@/components/ui/display";
import { PolicyLinks } from "@/components/public";
import { formatDay } from "@/lib/utils";

export default function PolicyPageView({ params }: { params: { slug: string } }) {
  const { config } = usePlatform();
  const { data, isLoading, error } = useQuery<{ data: PolicyPage }>({ queryKey: [`/api/policy-pages/${params.slug}`], retry: false });
  const page = data?.data;

  useEffect(() => {
    if (page) document.title = `${page.metaTitle || page.title} · ${config?.siteTitle ?? ""}`;
  }, [page, config?.siteTitle]);

  return (
    <div className="min-h-full bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <img src={config?.logo || "/favicon.svg"} alt="" className="h-8 w-8 rounded object-contain" />
          <span className="font-semibold">{config?.siteTitle}</span>
          <Link href="/login" className="ml-auto inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        {isLoading ? (
          <PageLoader />
        ) : error || !page ? (
          <EmptyState title="Page not found" description="This page doesn't exist or isn't published." />
        ) : (
          <article className="rounded-xl border border-border bg-surface p-6 sm:p-10">
            <Markdown source={page.content} />
            <p className="mt-8 text-xs text-fg-muted">Last updated {formatDay(page.updatedAt)}</p>
          </article>
        )}
        <div className="mt-8">
          <PolicyLinks />
        </div>
      </main>
    </div>
  );
}
