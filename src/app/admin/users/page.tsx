import { requireAdminPageUser } from "@/lib/page-auth";
import AdminUsersClient from "./admin-users-client";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await requireAdminPageUser("/admin/users");
  return <AdminUsersClient />;
}
