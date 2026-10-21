"use client";

export default function PurchaseOrderPrintButton({ label }: { label: string }) {
  return (
    <button
      className="button supplier-po-print"
      type="button"
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}
