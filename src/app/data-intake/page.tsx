import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/page-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import DataIntakeClient from "./data-intake-client";

export const dynamic = "force-dynamic";

export default async function DataIntakePage() {
  const user = await requirePageUser("/data-intake");
  if (!canViewFilmOrders(user.email, user.role)) redirect("/history");
  return <DataIntakeClient viewer={user} />;
}
