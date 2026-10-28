"use client";

import { useEffect, useState } from "react";

export const DATA_UPLOAD_GUIDES = [
  { id: 1, href: "/docs/data-upload/data-input-guide-1.pdf", label: "データ入稿ガイド１" },
  { id: 2, href: "/docs/data-upload/data-input-guide-2.pdf", label: "データ入稿ガイド２" },
  { id: 3, href: "/docs/data-upload/data-input-guide-3.pdf", label: "データ入稿ガイド３" },
] as const;

export function allUploadGuidesChecked(checks: boolean[]): boolean {
  return DATA_UPLOAD_GUIDES.every((_, index) => checks[index] === true);
}

export function UploadGuideAcknowledgement({
  checks,
  onChange,
  title = "データ入稿ガイドの確認",
  description = "アップロード前に3冊すべてのガイドPDFを確認し、チェックを入れてください。",
}: {
  checks: boolean[];
  onChange: (index: number, checked: boolean) => void;
  title?: string;
  description?: string;
}) {
  const [availability, setAvailability] = useState<Array<boolean | null>>([null, null, null]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const results = await Promise.all(DATA_UPLOAD_GUIDES.map(async (guide) => {
        try {
          const response = await fetch(guide.href, { method: "HEAD", cache: "no-store" });
          return response.ok;
        } catch {
          return false;
        }
      }));
      if (active) setAvailability(results);
    })();
    return () => { active = false; };
  }, [])

  return (
    <section className="upload-guide-acknowledgement" aria-label={title}>
      <h4>{title}</h4>
      <p className="help">{description}</p>
      <ul>
        {DATA_UPLOAD_GUIDES.map((guide, index) => (
          <li key={guide.id}>
            <a href={guide.href} target="_blank" rel="noreferrer">
              {guide.label}.pdf を開く
            </a>
            {availability[index] === false ? <span className="guide-missing">未設置</span> : null}
            <label className="film-order-pdf-toggle">
              <input
                type="checkbox"
                checked={checks[index] === true}
                onChange={(event) => onChange(index, event.target.checked)}
              />
              確認しました
            </label>
          </li>
        ))}
      </ul>
      {availability.some((item) => item === false) ? (
        <p className="film-order-upload-error" role="alert">
          一部のガイドPDFがサーバーに設置されていません。管理者が `/public/docs/data-upload/` に配置する必要があります。
        </p>
      ) : null}
    </section>
  );
}
