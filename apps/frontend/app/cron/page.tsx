import { redirect } from "next/navigation";

export default function CronPage() {
  redirect("/admin/cron-health");
}
