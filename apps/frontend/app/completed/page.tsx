import { ExcludeListClient } from "../ExcludeListClient";

export const metadata = {
  title: "Completed | manhwa-scanner",
  description: "Completed series — hidden from RSS",
};

export default function CompletedPage() {
  return <ExcludeListClient initialStatus="Completed" />;
}
