export const dynamic = "force-static";

export default function PrivacyPage() {
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">PRIVACY POLICY</p>
        <h1>個人情報保護方針</h1>
        <div className="eta-privacy-body">
          <p>本アプリ（Seven Calcul / フィルム発注管理）は、金井貿易株式会社および株式会社セブン化学の業務向けツールです。</p>
          <h2>収集する情報</h2>
          <ul>
            <li>ログイン用メールアドレスおよび表示名</li>
            <li>見積・発注・フィルム製作データ（製品名、仕様、ファイル名、Driveリンク）</li>
            <li>ワークフロー操作履歴（誰が・いつ・何をしたか）</li>
          </ul>
          <h2>利用目的</h2>
          <p>収集した情報は、見積管理、フィルム発注、校正承認、納期管理など本業務の遂行にのみ使用します。</p>
          <h2>第三者提供</h2>
          <p>業務上必要なフィルムメーカー・デザイン会社への発注・校正連絡を除き、情報を第三者に提供しません。</p>
          <h2>データ保存</h2>
          <p>データは管理されたクラウドデータベース（Neon PostgreSQL）および指定された Google Drive フォルダに保存します。</p>
          <h2>お問い合わせ</h2>
          <p>金井貿易株式会社 担当者までメールにてご連絡ください。</p>
        </div>
      </section>
    </main>
  );
}
