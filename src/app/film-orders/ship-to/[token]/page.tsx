import { notFound } from "next/navigation";
import ShipToRequestClient from "./ship-to-client";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

export default async function CustomerShipToPage({ params }: PageProps) {
  const { token } = await params;
  return <ShipToRequestClient token={token} />;
}
