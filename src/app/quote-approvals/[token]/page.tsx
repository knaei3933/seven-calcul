import { notFound } from "next/navigation";
import CustomerApprovalClient from "./approval-client";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

export default async function CustomerApprovalPage({ params }: PageProps) {
  const { token } = await params;
  if (!token.trim()) notFound();
  return <CustomerApprovalClient token={token} />;
}
