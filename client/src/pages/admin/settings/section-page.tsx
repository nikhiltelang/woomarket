import NotFound from "@/pages/not-found";
import { SECTIONS, SimpleSection } from "./sections";
import { CronSection, LanguageSection, PoliciesSection } from "./extra-sections";

/** /system-settings/:section */
export default function SettingsSectionPage({ params }: { params: { section: string } }) {
  switch (params.section) {
    case "cron":
      return <CronSection />;
    case "policy-pages":
      return <PoliciesSection />;
    case "language":
      return <LanguageSection />;
    default:
      return SECTIONS[params.section] ? <SimpleSection slug={params.section} /> : <NotFound />;
  }
}
