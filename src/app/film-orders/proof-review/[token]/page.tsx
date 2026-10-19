import CustomerProofReviewClient from "./review-client";

export const dynamic = "force-dynamic";

export default async function CustomerProofReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CustomerProofReviewClient token={token} />;
}
