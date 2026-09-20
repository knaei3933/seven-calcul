import { redirect } from "next/navigation";
import { getCurrentUser, type AuthenticatedUser } from "@/lib/api-auth";

function safeNextPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || path.startsWith("/api/")) return "/";
  return path;
}

export async function requirePageUser(nextPath: string): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(safeNextPath(nextPath))}`);
  }
  return user;
}

export async function requireAdminPageUser(nextPath: string): Promise<AuthenticatedUser> {
  const user = await requirePageUser(nextPath);
  if (user.role !== "admin") redirect("/history");
  return user;
}
