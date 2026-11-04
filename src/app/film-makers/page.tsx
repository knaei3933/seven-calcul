import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/page-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import FilmMakersClient from "./film-makers-client";

export const dynamic = "force-dynamic";

export default async function FilmMakersPage() {
  const user = await requirePageUser("/film-makers");
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) redirect("/history");
  return <FilmMakersClient userEmail={user.email} />;
}
