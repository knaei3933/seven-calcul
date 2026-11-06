import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/page-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";

export const dynamic = "force-dynamic";

export default async function FilmOrdersPage() {
  const user = await requirePageUser("/film-orders");
  // Nested token routes are separate public route segments. Only this authenticated
  // internal list entrypoint moves to the new intake workflow.
  if (!canViewFilmOrders(user.email, user.role)) redirect("/history");
  redirect("/data-intake");
}
