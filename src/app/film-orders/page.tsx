import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/page-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import FilmOrdersClient from "./film-orders-client";

export const dynamic = "force-dynamic";

export default async function FilmOrdersPage() {
  const user = await requirePageUser("/film-orders");
  if (!canViewFilmOrders(user.email)) redirect("/history");
  return <FilmOrdersClient userEmail={user.email} />;
}
