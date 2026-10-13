import { requirePageUser } from "@/lib/page-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import SimulatorClient from "./simulator-client";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  const user = await requirePageUser("/");
  return <SimulatorClient userRole={user.role} kanaiMasterAccess={user.role === "admin" && isKaneiTradeUser(user.email)} />;
}
