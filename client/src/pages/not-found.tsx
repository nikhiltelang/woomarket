import { Link } from "wouter";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/layout/app-layout";

export default function NotFound() {
  return (
    <PageContainer>
      <EmptyState
        icon={<Compass className="h-10 w-10" />}
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={
          <Link href="/">
            <Button variant="outline">Back to home</Button>
          </Link>
        }
      />
    </PageContainer>
  );
}
