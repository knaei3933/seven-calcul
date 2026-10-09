import { requireAdminPageUser } from "@/lib/page-auth";
import FilmPricesClient from "./film-prices-client";

export const dynamic = "force-dynamic";

export default async function FilmPricesPage() {
  await requireAdminPageUser("/admin/film-prices");
  return <FilmPricesClient />;
}
