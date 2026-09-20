import { getCurrentUser } from "@/lib/api-auth";
import { GlobalHeaderClient } from "@/components/global-header-client";

export async function GlobalHeader() {
  const user = await getCurrentUser();

  return (
    <header className="global-header no-print">
      <GlobalHeaderClient user={user} />
    </header>
  );
}
