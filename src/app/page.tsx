import { requirePageUser } from "@/lib/page-auth";
import SimulatorClient from "./simulator-client";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  await requirePageUser("/");
  return <SimulatorClient />;
}
