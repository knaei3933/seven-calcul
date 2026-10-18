import CustomerDesignUploadClient from "./upload-client";

export const dynamic = "force-dynamic";

export default async function CustomerDesignUploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CustomerDesignUploadClient token={token} />;
}
