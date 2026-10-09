import { requireAdminPageUser } from "@/lib/page-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { redirect } from "next/navigation";
import FilmPricesClient from "./film-prices-client";

export const dynamic = "force-dynamic";

export default async function FilmPricesPage() {
  const user = await requireAdminPageUser("/admin/film-prices");
  if (!isKaneiTradeUser(user.email)) redirect("/");
  return <FilmPricesClient />;
}
