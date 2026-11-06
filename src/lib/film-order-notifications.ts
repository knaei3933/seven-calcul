import { createHash } from "node:crypto";
import {
  FILM_ORDER_WORKFLOW_STAGES,
  filmOrderWorkflowStageLabels,
  type FilmOrderWorkflowStage,
} from "./film-order-stage";

export const FILM_ORDER_NOTIFICATION_EVENTS = [
  "receiving_data_request",
  "maker_proof_request",
  "proof_received",
  "re_proof_request",
  "customer_proof_review",
  "customer_proof_decision",
  "final_approval",
  "supplier_purchase_order",
  "eta_update",
  "shipment_report",
  "delivery_report",
  "receipt_completion",
  "ship_to_request",
  "ship_to_registered",
  "customer_design_upload",
  "customer_design_correction",
  "customer_design_received",
  "production_plan_request",
  "link_resend",
] as const;

export type FilmOrderNotificationEvent = typeof FILM_ORDER_NOTIFICATION_EVENTS[number];

export type FilmOrderNotificationAudience = "maker" | "seven" | "kanei" | "customer";
export type FilmOrderNotificationLanguage = "ja" | "ko";

export const FILM_ORDER_NOTIFICATION_AUDIENCES = [
  "maker",
  "seven",
  "kanei",
  "customer",
] as const satisfies readonly FilmOrderNotificationAudience[];

export const FILM_ORDER_NOTIFICATION_LINK_KEYS = [
  "maker_receiving_packet",
  "maker_customer_design_file",
  "maker_proof_upload",
  "maker_purchase_order",
  "maker_eta_report",
  "kanei_order_management",
  "seven_order_summary",
  "customer_design_upload",
  "customer_proof_review",
] as const;

export type FilmOrderNotificationLinkKey = typeof FILM_ORDER_NOTIFICATION_LINK_KEYS[number];

export const FILM_ORDER_LINK_ALLOWLISTS: Readonly<
  Record<FilmOrderNotificationAudience, readonly FilmOrderNotificationLinkKey[]>
> = {
  maker: ["maker_receiving_packet", "maker_customer_design_file", "maker_proof_upload", "maker_purchase_order", "maker_eta_report"],
  seven: ["seven_order_summary"],
  kanei: FILM_ORDER_NOTIFICATION_LINK_KEYS,
  customer: ["customer_design_upload", "customer_proof_review"],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'）)\u3001\u3002]+/gu;

export interface FilmOrderNotificationLink {
  key: FilmOrderNotificationLinkKey;
  url: string;
  label?: string;
}

export interface FilmOrderMailAttachmentMetadata {
  fileName: string;
  category: string;
  version?: number;
  contentType?: string;
}

export interface FilmOrderMakerProjectionInput {
  companyName: string;
  contactName?: string;
  email?: string;
  language: FilmOrderNotificationLanguage;
}

export interface FilmOrderNotificationInput {
  orderId: number;
  dispatchGroupId: string;
  orderNumber: string;
  productName: string;
  productSpecification: string;
  workflowStage: FilmOrderWorkflowStage;
  recipients: Partial<Record<FilmOrderNotificationAudience, string>>;
  senderIdentity: Partial<Record<FilmOrderNotificationAudience, string>>;
  senderEmail: string;
  cc?: Partial<Record<FilmOrderNotificationAudience, readonly string[]>>;
  maker?: FilmOrderMakerProjectionInput;
  customerName?: string;
  quotationNumber?: string;
  purchaseOrderNumber?: string;
  internalCostSummary?: string;
  deadlineAt?: string;
  links?: readonly FilmOrderNotificationLink[];
  attachments?: readonly FilmOrderMailAttachmentMetadata[];
  customerReceivingInputRequired?: boolean;
  customerEtaActionRequired?: boolean;
  customerMessage?: string;
  linkResendAudiences?: readonly FilmOrderNotificationAudience[];
  overrides?: Record<string, FilmOrderNotificationTemplateOverride>;
  bindingFingerprint?: string;
}

export interface FilmOrderNotificationTemplateOverride {
  subject?: string;
  body?: string;
  cc?: readonly string[];
}

export interface FilmOrderNotificationEnvelope {
  orderId: number;
  dispatchGroupId: string;
  orderNumber: string;
  productName: string;
  productSpecification: string;
  workflowKey: FilmOrderNotificationEvent;
  workflowStage: FilmOrderWorkflowStage;
  audience: FilmOrderNotificationAudience;
  language: FilmOrderNotificationLanguage;
  templateKey: string;
  effectiveTemplateIdentity: {
    key: string;
    source: "default" | "override";
    compatibilityKey: string | null;
    bindingFingerprint: string;
  };
  senderIdentity: string;
  senderEmail: string;
  intendedTo: string;
  cc: string[];
  subject: string;
  body: string;
  links: FilmOrderNotificationLink[];
  attachments: FilmOrderMailAttachmentMetadata[];
  purpose: {
    kind: "action" | "informational";
    text: string;
  };
  nextStep: string;
  deadlineAt: string | null;
  contentHash: string;
}

/** Source values checked by deterministic disclosure validation; never stored on or serialized with an envelope. */
export interface FilmOrderNotificationDisclosureContext {
  makerCompanyName?: string;
  makerContact?: string;
  purchaseOrderNumber?: string;
  internalCostSummary?: string;
}

export type FilmOrderNotificationValidationPoint =
  | "purpose"
  | "sender_identity"
  | "recipient"
  | "order_number"
  | "product_spec"
  | "workflow_stage"
  | "action_or_purpose"
  | "required_link"
  | "language"
  | "next_step"
  | "disclosure";

export interface FilmOrderNotificationIssue {
  audience?: FilmOrderNotificationAudience;
  templateKey?: string;
  point: FilmOrderNotificationValidationPoint;
  code: string;
  message: string;
}

export type FilmOrderNotificationBuildResult =
  | { ok: true; envelopes: FilmOrderNotificationEnvelope[] }
  | { ok: false; envelopes: []; errors: FilmOrderNotificationIssue[] };

export type FilmOrderNotificationValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: FilmOrderNotificationIssue[] };

interface EventText {
  subjectJa: string;
  subjectKo: string;
  makerJa: string;
  makerKo: string;
  internalJa: string;
  customerJa: string;
  nextJa: string;
  nextKo: string;
}

const EVENT_TEXT: Record<FilmOrderNotificationEvent, EventText> = {
  receiving_data_request: {
    subjectJa: "制作データ受領依頼",
    subjectKo: "제작 데이터 수령 요청",
    makerJa: "制作データを受領し、校正データを提出してください。",
    makerKo: "제작 데이터를 수령하고 교정 데이터를 제출해 주십시오.",
    internalJa: "フィルムメーカーへ制作データを依頼します。",
    customerJa: "デザインデータをご入稿ください。",
    nextJa: "データ確認後に校正制作へ進みます。",
    nextKo: "데이터 확인 후 교정 제작을 진행합니다.",
  },
  maker_proof_request: {
    subjectJa: "校正データ提出依頼",
    subjectKo: "교정 데이터 제출 요청",
    makerJa: "専用ページからAIとPDFの校正データを提出してください。",
    makerKo: "전용 페이지에서 AI와 PDF 교정 데이터를 제출해 주십시오.",
    internalJa: "フィルムメーカーへ校正データ提出を依頼します。",
    customerJa: "校正制作中です。",
    nextJa: "提出後に顧客校正確認へ進みます。",
    nextKo: "제출 후 고객 교정 확인으로 진행합니다.",
  },
  proof_received: {
    subjectJa: "校正データ受領",
    subjectKo: "교정 데이터 수령",
    makerJa: "校正データを受領しました。",
    makerKo: "교정 데이터를 수령했습니다.",
    internalJa: "フィルムメーカーから校正データが提出されました。",
    customerJa: "校正データが登録されました。",
    nextJa: "内容確認後に顧客校正確認へ進めます。",
    nextKo: "내용 확인 후 고객 교정 확인으로 진행합니다.",
  },
  re_proof_request: {
    subjectJa: "再校正依頼",
    subjectKo: "재교정 요청",
    makerJa: "修正内容を反映し、再度AIとPDFを提出してください。",
    makerKo: "수정 내용을 반영하고 다시 AI와 PDF를 제출해 주십시오.",
    internalJa: "顧客指摘に基づき再校正を依頼します。",
    customerJa: "修正依頼を記録しました。",
    nextJa: "再提出後に再度顧客確認を行います。",
    nextKo: "재제출 후 다시 고객 확인을 진행합니다.",
  },
  customer_proof_review: {
    subjectJa: "校正データご確認のお願い",
    subjectKo: "교정 데이터 확인 요청",
    makerJa: "校正データを顧客確認中です。",
    makerKo: "교정 데이터를 고객 확인 중입니다.",
    internalJa: "顧客へ校正確認を依頼します。",
    customerJa: "専用ページで校正データをご確認のうえ、承認または修正依頼を選択してください。",
    nextJa: "顧客判断後に承認または再校正へ進みます。",
    nextKo: "고객 판단 후 승인 또는 재교정으로 진행합니다.",
  },
  customer_proof_decision: {
    subjectJa: "校正確認結果",
    subjectKo: "교정 확인 결과",
    makerJa: "顧客の校正確認結果をお知らせします。",
    makerKo: "고객의 교정 확인 결과를 알려드립니다.",
    internalJa: "顧客の校正確認結果を記録しました。",
    customerJa: "校正確認の結果を受け付けました。",
    nextJa: "判断内容に応じて次の工程へ進めます。",
    nextKo: "판단 내용에 따라 다음 공정으로 진행합니다.",
  },
  final_approval: {
    subjectJa: "最終承認完了",
    subjectKo: "최종 승인 완료",
    makerJa: "校正データが最終承認されました。承認済みデータで製作を進めてください。",
    makerKo: "교정 데이터가 최종 승인되었습니다. 승인된 데이터로 제작을 진행해 주십시오.",
    internalJa: "校正データの最終承認が完了しました。",
    customerJa: "校正データが承認されました。",
    nextJa: "発注・物流準備へ進みます。",
    nextKo: "발주와 물류 준비로 진행합니다.",
  },
  supplier_purchase_order: {
    subjectJa: "フィルム発注依頼",
    subjectKo: "필름 발주 요청",
    makerJa: "発注内容を確認し、受領可否と納期見込みを登録してください。",
    makerKo: "발주 내용을 확인하고 수령 가능 여부와 납기 전망을 등록해 주십시오.",
    internalJa: "選定したフィルムメーカーへ発注します。",
    customerJa: "フィルム発注準備が完了しました。",
    nextJa: "受領可否と納期見込みの登録を待ちます。",
    nextKo: "수령 가능 여부와 납기 전망 등록을 기다립니다.",
  },
  eta_update: {
    subjectJa: "納期見込み更新",
    subjectKo: "납기 전망 업데이트",
    makerJa: "納期見込みを確認し、専用ページへ登録してください。",
    makerKo: "납기 전망을 확인하고 전용 페이지에 등록해 주십시오.",
    internalJa: "納期見込みを共有します。",
    customerJa: "フィルム納期見込みを確認中です。",
    nextJa: "確定した納期に合わせて出荷準備へ進みます。",
    nextKo: "확정된 납기에 맞춰 출하 준비로 진행합니다.",
  },
  shipment_report: {
    subjectJa: "フィルム出荷報告",
    subjectKo: "필름 출하 보고",
    makerJa: "出荷報告を受け付けました。",
    makerKo: "출하 보고를 접수했습니다.",
    internalJa: "フィルムが出荷されました。",
    customerJa: "フィルムが出荷されました。到着まで今しばらくお待ちください。",
    nextJa: "納品報告と受領確認へ進みます。",
    nextKo: "납품 보고와 수령 확인으로 진행합니다.",
  },
  delivery_report: {
    subjectJa: "フィルム納品報告",
    subjectKo: "필름 납품 보고",
    makerJa: "納品報告を受け付けました。",
    makerKo: "납품 보고를 접수했습니다.",
    internalJa: "フィルムが納品されました。",
    customerJa: "フィルムが納品されました。",
    nextJa: "受領確認後に製造準備へ進めます。",
    nextKo: "수령 확인 후 제조 준비로 진행합니다.",
  },
  receipt_completion: {
    subjectJa: "フィルム受領完了",
    subjectKo: "필름 수령 완료",
    makerJa: "フィルムの受領確認が完了しました。",
    makerKo: "필름의 수령 확인이 완료되었습니다.",
    internalJa: "フィルムの受領確認が完了しました。",
    customerJa: "フィルム受領が完了しました。",
    nextJa: "本案件のフィルム調達は完了です。",
    nextKo: "본 건의 필름 조달이 완료되었습니다.",
  },
  ship_to_request: {
    subjectJa: "納品先登録依頼",
    subjectKo: "납품지 등록 요청",
    makerJa: "納品先登録依頼を顧客へ送信しました。",
    makerKo: "납품지 등록 요청을 고객에게 보냈습니다.",
    internalJa: "顧客へ納品先登録を依頼します。",
    customerJa: "専用ページで納品先を登録してください。",
    nextJa: "顧客登録後に納品先を確認します。",
    nextKo: "고객 등록 후 납품지를 확인합니다.",
  },
  ship_to_registered: {
    subjectJa: "納品先登録完了",
    subjectKo: "납품지 등록 완료",
    makerJa: "納品先登録を受け付けました。",
    makerKo: "납품지 등록을 접수했습니다.",
    internalJa: "顧客の納品先登録を受け付けました。",
    customerJa: "納品先登録を受け付けました。",
    nextJa: "確認後に納品先を確定します。",
    nextKo: "확인 후 납품지를 확정합니다.",
  },
  customer_design_upload: {
    subjectJa: "デザイン原稿ご入稿のお願い",
    subjectKo: "디자인 원본 제출 요청",
    makerJa: "顧客デザインの入稿を依頼しました。",
    makerKo: "고객 디자인 제출을 요청했습니다.",
    internalJa: "顧客へデザイン原稿の入稿を依頼します。",
    customerJa: "専用ページからAIデザイン原稿をアップロードしてください。",
    nextJa: "顧客入稿後に内容を確認します。",
    nextKo: "고객 제출 후 내용을 확인합니다.",
  },
  customer_design_correction: {
    subjectJa: "デザイン原稿修正のお願い",
    subjectKo: "디자인 원본 수정 요청",
    makerJa: "顧客デザイン修正を依頼しました。",
    makerKo: "고객 디자인 수정을 요청했습니다.",
    internalJa: "顧客へデザイン修正を依頼します。",
    customerJa: "ご指摘内容を反映し、修正AI原稿を再アップロードしてください。",
    nextJa: "修正入稿後に再確認します。",
    nextKo: "수정 제출 후 다시 확인합니다.",
  },
  customer_design_received: {
    subjectJa: "制作データ受領・校正データ提出依頼",
    subjectKo: "제작 데이터 수령·교정 데이터 제출 요청",
    makerJa: "顧客から受領したAI制作データを専用リンクから取得し、校正データを専用ページから提出してください。",
    makerKo: "고객에게 수령한 AI 제작 데이터를 전용 링크에서 받고, 교정 데이터를 전용 업로드 페이지로 제출해 주십시오.",
    internalJa: "顧客AIデータを選定フィルムメーカーへ引き継ぎました。",
    customerJa: "デザイン原稿の入稿を受け付けました。",
    nextJa: "受領データを確認して製作を開始してください。",
    nextKo: "수령 데이터를 확인하고 제작을 시작해 주십시오.",
  },
  production_plan_request: {
    subjectJa: "生産予定確認のお願い",
    subjectKo: "생산 일정 확인 요청",
    makerJa: "生産予定を確認してください。",
    makerKo: "생산 일정을 확인해 주십시오.",
    internalJa: "Sevenへ生産予定確認を依頼します。",
    customerJa: "製造準備予定を共有しています。",
    nextJa: "確定予定を受領後に共有します。",
    nextKo: "확정 일정을 수령한 후 공유합니다.",
  },
  link_resend: {
    subjectJa: "ワークフローリンク再送",
    subjectKo: "워크플로 링크 재전송",
    makerJa: "既存の発注を対象に専用リンクを再送します。必要な報告を継続してください。",
    makerKo: "기존 발주를 대상으로 전용 링크를 재전송합니다. 필요한 보고를 계속해 주십시오.",
    internalJa: "対象者へ既存リンクを再送しました。発注IDは変更されません。",
    customerJa: "既存案件の専用リンクを再送します。発注は新規作成されません。",
    nextJa: "既存の案件IDで継続します。",
    nextKo: "기존 발주 ID로 계속 진행합니다.",
  },
};

const EVENT_PROJECTIONS: Record<
  FilmOrderNotificationEvent,
  readonly FilmOrderNotificationAudience[]
> = {
  receiving_data_request: ["maker", "seven", "kanei", "customer"],
  maker_proof_request: ["maker", "seven", "kanei"],
  proof_received: ["seven", "kanei"],
  re_proof_request: ["maker", "seven", "kanei"],
  customer_proof_review: ["customer", "seven", "kanei"],
  customer_proof_decision: ["customer", "seven", "kanei"],
  final_approval: ["maker", "seven", "kanei"],
  supplier_purchase_order: ["maker", "seven", "kanei"],
  eta_update: ["maker", "seven", "kanei", "customer"],
  shipment_report: ["maker", "seven", "kanei", "customer"],
  delivery_report: ["maker", "seven", "kanei", "customer"],
  receipt_completion: ["maker", "seven", "kanei", "customer"],
  ship_to_request: ["customer", "seven", "kanei"],
  ship_to_registered: ["customer", "seven", "kanei"],
  customer_design_upload: ["customer", "kanei"],
  customer_design_correction: ["customer", "kanei"],
  customer_design_received: ["maker", "seven", "kanei"],
  production_plan_request: ["seven"],
  link_resend: ["maker", "seven", "kanei", "customer"],
};

const ACTION_AUDIENCES: Record<FilmOrderNotificationEvent, readonly FilmOrderNotificationAudience[]> = {
  receiving_data_request: ["maker", "customer"],
  maker_proof_request: ["maker"],
  proof_received: [],
  re_proof_request: ["maker"],
  customer_proof_review: ["customer"],
  customer_proof_decision: [],
  final_approval: ["maker", "seven", "kanei"],
  supplier_purchase_order: ["maker"],
  eta_update: ["maker"],
  shipment_report: [],
  delivery_report: [],
  receipt_completion: [],
  ship_to_request: ["customer"],
  ship_to_registered: [],
  customer_design_upload: ["customer"],
  customer_design_correction: ["customer"],
  customer_design_received: [],
  production_plan_request: [],
  link_resend: ["maker", "customer"],
};

const REQUIRED_LINKS: Record<
  FilmOrderNotificationEvent,
  Partial<Record<FilmOrderNotificationAudience, readonly FilmOrderNotificationLinkKey[]>>
> = {
  receiving_data_request: {
    maker: ["maker_receiving_packet", "maker_proof_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
    customer: ["customer_design_upload"],
  },
  maker_proof_request: {
    maker: ["maker_receiving_packet", "maker_proof_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  proof_received: {
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  re_proof_request: {
    maker: ["maker_receiving_packet", "maker_proof_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  customer_proof_review: {
    customer: ["customer_proof_review"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  customer_proof_decision: {
    customer: [],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  final_approval: {
    maker: [],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  supplier_purchase_order: {
    maker: ["maker_purchase_order", "maker_eta_report"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  eta_update: {
    maker: ["maker_eta_report"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
    customer: [],
  },
  shipment_report: {
    maker: [],
    seven: [],
    kanei: [],
    customer: [],
  },
  delivery_report: {
    maker: [],
    seven: [],
    kanei: [],
    customer: [],
  },
  receipt_completion: {
    maker: [],
    seven: [],
    kanei: [],
    customer: [],
  },
  ship_to_request: {
    customer: ["customer_design_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  ship_to_registered: {
    customer: [],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  customer_design_upload: {
    customer: ["customer_design_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  customer_design_correction: {
    customer: ["customer_design_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  customer_design_received: {
    maker: ["maker_customer_design_file", "maker_proof_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
  },
  production_plan_request: {
    seven: ["seven_order_summary"],
  },
  link_resend: {
    maker: ["maker_proof_upload"],
    seven: ["seven_order_summary"],
    kanei: ["kanei_order_management"],
    customer: ["customer_proof_review"],
  },
};

const COMPATIBILITY_TEMPLATE_KEYS: Partial<
  Record<FilmOrderNotificationEvent, Partial<Record<FilmOrderNotificationAudience, string>>>
> = {
  receiving_data_request: { maker: "film_receiving_notice" },
  maker_proof_request: { maker: "film_proof_request" },
  proof_received: { seven: "film_proof_received", kanei: "film_proof_received" },
  re_proof_request: { maker: "film_reproof_request" },
  customer_proof_review: { customer: "customer_proof_review_request" },
  customer_proof_decision: { customer: "customer_proof_decision" },
  final_approval: { maker: "film_approval_final" },
  supplier_purchase_order: { maker: "film_purchase_order_supplier", seven: "film_purchase_order_internal", kanei: "film_purchase_order_internal" },
  eta_update: { maker: "film_eta_supplier", seven: "film_eta_internal", kanei: "film_eta_internal" },
  shipment_report: { seven: "film_delivery_shipped", kanei: "film_delivery_shipped", customer: "film_delivery_shipped" },
  delivery_report: { seven: "film_delivery_completed", kanei: "film_delivery_completed", customer: "film_delivery_completed" },
  receipt_completion: { maker: "film_receipt_confirmed", seven: "film_receipt_confirmed", kanei: "film_receipt_confirmed", customer: "film_receipt_confirmed" },
  ship_to_request: { customer: "film_ship_to_request", seven: "film_ship_to_request", kanei: "film_ship_to_request" },
  ship_to_registered: { customer: "film_ship_to_registered", seven: "film_ship_to_registered", kanei: "film_ship_to_registered" },
  customer_design_upload: { customer: "customer_design_request", seven: "customer_design_request", kanei: "customer_design_request" },
  customer_design_correction: { customer: "customer_design_correction", seven: "customer_design_correction", kanei: "customer_design_correction" },
  customer_design_received: { seven: "customer_design_received", kanei: "customer_design_received" },
  production_plan_request: { seven: "film_production_plan_request" },
  link_resend: { maker: "film_supplier_links_resend" },
};

const LINK_VARIABLES: Record<FilmOrderNotificationLinkKey, string> = {
  maker_receiving_packet: "makerReceivingPacketUrl",
  maker_customer_design_file: "makerCustomerDesignFileUrl",
  maker_proof_upload: "makerProofUploadUrl",
  maker_purchase_order: "makerPurchaseOrderUrl",
  maker_eta_report: "makerEtaReportUrl",
  kanei_order_management: "kaneiOrderManagementUrl",
  seven_order_summary: "sevenOrderSummaryUrl",
  customer_design_upload: "customerDesignUploadUrl",
  customer_proof_review: "customerProofReviewUrl",
};

const MAKER_STAGE_LABELS: Record<FilmOrderWorkflowStage, string> = {
  contract_accepted: "계약 수주",
  maker_requested: "필름 메이커 의뢰",
  data_intake: "제작 데이터 접수",
  proof_registered: "교정 제작",
  customer_review: "고객 교정 확인",
  approved: "교정 승인",
  correction: "재교정",
  final_approvals: "최종 승인",
  po: "필름 발주",
  eta: "납기 전망",
  shipment: "출하 보고",
  delivery: "납품 보고",
  receipt: "수령 확인",
  complete: "완료",
};

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJsonStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function interpolateFilmOrderNotificationTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key: string) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function filmOrderNotificationEnvelopeHash(envelope: Omit<FilmOrderNotificationEnvelope, "contentHash">): string {
  const payload = {
    senderIdentity: envelope.senderIdentity,
    senderEmail: envelope.senderEmail,
    intendedTo: envelope.intendedTo,
    cc: envelope.cc,
    language: envelope.language,
    subject: envelope.subject,
    body: envelope.body,
    links: envelope.links,
    attachments: envelope.attachments,
    effectiveTemplateIdentity: envelope.effectiveTemplateIdentity,
    workflowKey: envelope.workflowKey,
    purpose: envelope.purpose,
    nextStep: envelope.nextStep,
    deadlineAt: envelope.deadlineAt,
    orderNumber: envelope.orderNumber,
    productName: envelope.productName,
    productSpecification: envelope.productSpecification,
    workflowStage: envelope.workflowStage,
    dispatchContext: {
      orderId: envelope.orderId,
      dispatchGroupId: envelope.dispatchGroupId,
    },
  };
  return createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export function expectedFilmOrderNotificationAudiences(
  event: FilmOrderNotificationEvent,
  input: Pick<
    FilmOrderNotificationInput,
    "customerReceivingInputRequired" | "customerEtaActionRequired" | "linkResendAudiences"
  > = {},
): FilmOrderNotificationAudience[] {
  const configured = EVENT_PROJECTIONS[event];
  if (event === "receiving_data_request") {
    return input.customerReceivingInputRequired === true ? [...configured] : configured.filter((audience) => audience !== "customer");
  }
  if (event === "link_resend") {
    const requested = input.linkResendAudiences ?? ["maker", "seven", "kanei"];
    return FILM_ORDER_NOTIFICATION_AUDIENCES.filter((audience) => requested.includes(audience));
  }
  if (event === "eta_update") {
    return input.customerEtaActionRequired === true ? [...configured] : configured.filter((audience) => audience !== "customer");
  }
  return [...configured];
}

function issue(
  envelope: Pick<FilmOrderNotificationEnvelope, "audience" | "templateKey">,
  point: FilmOrderNotificationValidationPoint,
  code: string,
  message: string,
): FilmOrderNotificationIssue {
  return { audience: envelope.audience, templateKey: envelope.templateKey, point, code, message };
}

function normalizedLinksForAudience(
  event: FilmOrderNotificationEvent,
  audience: FilmOrderNotificationAudience,
  links: readonly FilmOrderNotificationLink[] | undefined,
): FilmOrderNotificationLink[] {
  const allowed = new Set(FILM_ORDER_LINK_ALLOWLISTS[audience]);
  const configured = REQUIRED_LINKS[event][audience];
  const selected = configured ? new Set(configured) : allowed;
  const seen = new Set<string>();
  const result: FilmOrderNotificationLink[] = [];
  for (const link of links ?? []) {
    if (!allowed.has(link.key) || !selected.has(link.key) || seen.has(link.key)) continue;
    seen.add(link.key);
    result.push({ key: link.key, url: link.url, ...(link.label ? { label: link.label } : {}) });
  }
  return result;
}

function templateForProjection(
  event: FilmOrderNotificationEvent,
  audience: FilmOrderNotificationAudience,
  overrides: Record<string, FilmOrderNotificationTemplateOverride> | undefined,
): {
  key: string;
  compatibilityKey: string | null;
  override: FilmOrderNotificationTemplateOverride | null;
} {
  const key = `film_order.${event}.${audience}`;
  const compatibilityKey = COMPATIBILITY_TEMPLATE_KEYS[event]?.[audience] ?? null;
  const override = overrides?.[key] ?? (compatibilityKey ? overrides?.[compatibilityKey] : undefined) ?? null;
  return { key, compatibilityKey, override };
}

function localeFor(
  audience: FilmOrderNotificationAudience,
  maker: FilmOrderMakerProjectionInput | undefined,
): FilmOrderNotificationLanguage {
  return audience === "maker" ? maker?.language ?? "ja" : "ja";
}

function linkLines(links: readonly FilmOrderNotificationLink[], language: FilmOrderNotificationLanguage): string[] {
  if (links.length === 0) return [];
  const label = language === "ko" ? "전용 링크" : "専用リンク";
  return [
    `【${label}】`,
    ...links.map((link) => `${link.label ?? link.key}: ${link.url}`),
  ];
}

function attachmentLines(
  attachments: readonly FilmOrderMailAttachmentMetadata[],
  language: FilmOrderNotificationLanguage,
): string[] {
  if (attachments.length === 0) return [];
  const label = language === "ko" ? "첨부 데이터" : "対象データ";
  return [
    `【${label}】`,
    ...attachments.map((attachment) => `${attachment.fileName} (${attachment.category}${attachment.version ? ` v${attachment.version}` : ""})`),
  ];
}

function defaultSubject(event: FilmOrderNotificationEvent, language: FilmOrderNotificationLanguage, input: FilmOrderNotificationInput): string {
  const text = EVENT_TEXT[event];
  return `[${language === "ko" ? text.subjectKo : text.subjectJa}] ${input.orderNumber} ${input.productName}`;
}

function defaultBody(
  event: FilmOrderNotificationEvent,
  audience: FilmOrderNotificationAudience,
  input: FilmOrderNotificationInput,
  links: readonly FilmOrderNotificationLink[],
): { body: string; purposeText: string; nextStep: string } {
  const text = EVENT_TEXT[event];
  const language = localeFor(audience, input.maker);
  const purposeText = audience === "maker"
    ? (language === "ko" ? text.makerKo : text.makerJa)
    : audience === "customer" ? text.customerJa : text.internalJa;
  const nextStep = language === "ko" ? text.nextKo : text.nextJa;
  const stageLabel = language === "ko" ? MAKER_STAGE_LABELS[input.workflowStage] : filmOrderWorkflowStageLabels[input.workflowStage];
  const customerLabel = language === "ko" ? "고객명" : "顧客名";
  const stageLabelName = language === "ko" ? "현재 단계" : "現在のワークフロー段階";
  const senderLabel = language === "ko" ? "발행자" : "発行者";
  const recipientLabel = language === "ko" ? "수신자" : "宛先";
  const purposeLabel = language === "ko" ? "요청 내용" : "依頼内容";
  const nextLabel = language === "ko" ? "다음 단계" : "次のステップ";

  const lines = [
    `【${purposeLabel}】`,
    purposeText,
    ...(event === "customer_design_correction" && audience === "customer" && input.customerMessage?.trim() ? [input.customerMessage.trim(), ""] : []),
    "",
    `【${language === "ko" ? "案件 정보" : "案件情報"}】`,
    `${language === "ko" ? "발주 번호" : "発注番号"}：${input.orderNumber}`,
    `${language === "ko" ? "품목" : "品名"}：${input.productName}`,
    `${language === "ko" ? "사양" : "仕様"}：${input.productSpecification}`,
    `${stageLabelName}：${stageLabel}`,
  ];
  if (input.quotationNumber && audience !== "customer") lines.push(`${language === "ko" ? "견적 번호" : "見積番号"}：${input.quotationNumber}`);
  if (input.customerName) lines.push(`${customerLabel}：${input.customerName}`);
  if (input.purchaseOrderNumber && audience !== "customer") {
    lines.push(`${language === "ko" ? "내부 발주 번호" : "内部発注番号"}：${input.purchaseOrderNumber}`);
  }
  if (input.internalCostSummary && audience === "kanei") {
    lines.push(`${language === "ko" ? "내부 비용" : "内部コスト"}：${input.internalCostSummary}`);
  }
  if (input.maker && (audience === "maker" || audience === "kanei")) {
    lines.push(`${language === "ko" ? "필름 메이커" : "フィルムメーカー"}：${input.maker.companyName}`);
    if (input.maker.contactName) lines.push(`${language === "ko" ? "담당자" : "担当者"}：${input.maker.contactName}`);
    if (input.maker.email) lines.push(`${language === "ko" ? "담당자 이메일" : "担当者メール"}：${input.maker.email}`);
  }
  lines.push(
    "",
    `【${nextLabel}】`,
    nextStep,
    ...(input.deadlineAt ? [(language === "ko" ? `기한：${input.deadlineAt}` : `期限：${input.deadlineAt}`)] : []),
    "",
    ...linkLines(links, language),
    ...attachmentLines(input.attachments ?? [], language),
    "",
    `${senderLabel}：${input.senderIdentity[audience] ?? ""}`,
    `${recipientLabel}：${input.recipients[audience] ?? ""}`,
  );
  return { body: lines.filter((line, index) => line !== "" || index > 0).join("\n"), purposeText, nextStep };
}

function bodyVariables(
  event: FilmOrderNotificationEvent,
  audience: FilmOrderNotificationAudience,
  input: FilmOrderNotificationInput,
): Record<string, unknown> {
  const stage = audience === "maker" && input.maker?.language === "ko"
    ? MAKER_STAGE_LABELS[input.workflowStage]
    : filmOrderWorkflowStageLabels[input.workflowStage];
  const variables: Record<string, unknown> = {
    eventSubject: EVENT_TEXT[event].subjectJa,
    requestedAction: audience === "maker"
      ? (localeFor(audience, input.maker) === "ko" ? EVENT_TEXT[event].makerKo : EVENT_TEXT[event].makerJa)
      : audience === "customer" ? EVENT_TEXT[event].customerJa : EVENT_TEXT[event].internalJa,
    nextStep: localeFor(audience, input.maker) === "ko" ? EVENT_TEXT[event].nextKo : EVENT_TEXT[event].nextJa,
    orderNumber: input.orderNumber,
    productName: input.productName,
    productSpecification: input.productSpecification,
    workflowStage: stage,
    customerName: input.customerName ?? "",
    quotationNumber: audience === "customer" ? "" : input.quotationNumber ?? "",
    deadlineAt: input.deadlineAt ?? "",
    customerMessage: input.customerMessage ?? "",
    senderIdentity: input.senderIdentity[audience] ?? "",
    recipient: input.recipients[audience] ?? "",
  };
  if (audience !== "customer") variables.purchaseOrderNumber = input.purchaseOrderNumber ?? "";
  if (audience === "kanei") variables.internalCostSummary = input.internalCostSummary ?? "";
  if ((audience === "maker" || audience === "kanei") && input.maker) {
    variables.makerCompanyName = input.maker.companyName;
    variables.makerContactName = input.maker.contactName ?? "";
    variables.makerEmail = input.maker.email ?? "";
  }
  for (const key of FILM_ORDER_LINK_ALLOWLISTS[audience]) {
    const link = input.links?.find((candidate) => candidate.key === key);
    variables[LINK_VARIABLES[key]] = link?.url ?? "";
  }
  return variables;
}

function containsValue(haystack: string, needle: string | undefined): boolean {
  return Boolean(needle?.trim()) && haystack.toLowerCase().includes(needle!.trim().toLowerCase());
}

export function validateFilmOrderNotification(
  envelope: FilmOrderNotificationEnvelope,
  disclosureContext: FilmOrderNotificationDisclosureContext = {},
): FilmOrderNotificationValidationResult {
  const issues: FilmOrderNotificationIssue[] = [];
  const content = `${envelope.subject}\n${envelope.body}`;

  if (!envelope.workflowKey || !envelope.subject.trim()) {
    issues.push(issue(envelope, "purpose", "notification_purpose_missing", "Subject and workflow purpose are required."));
  }
  if (!envelope.senderIdentity.trim() || envelope.senderIdentity.length > 200) {
    issues.push(issue(envelope, "sender_identity", "sender_identity_missing", "Sender identity is required."));
  }
  if (!EMAIL_PATTERN.test(envelope.intendedTo.trim())) {
    issues.push(issue(envelope, "recipient", "intended_recipient_invalid", "A valid intended recipient is required."));
  }
  if (envelope.cc.some((address) => !EMAIL_PATTERN.test(address.trim()))) {
    issues.push(issue(envelope, "recipient", "cc_recipient_invalid", "Every CC recipient must be a valid address."));
  }
  if (!envelope.orderNumber.trim()) {
    issues.push(issue(envelope, "order_number", "order_number_missing", "Order number is required."));
  }
  if (!envelope.productName.trim() || !envelope.productSpecification.trim()) {
    issues.push(issue(envelope, "product_spec", "product_spec_missing", "Product name and specification are required."));
  }
  if (!FILM_ORDER_WORKFLOW_STAGES.includes(envelope.workflowStage as FilmOrderWorkflowStage)) {
    issues.push(issue(envelope, "workflow_stage", "workflow_stage_invalid", "A canonical workflow stage is required."));
  } else if (!content.includes(envelope.language === "ko"
    ? MAKER_STAGE_LABELS[envelope.workflowStage as FilmOrderWorkflowStage]
    : filmOrderWorkflowStageLabels[envelope.workflowStage as FilmOrderWorkflowStage])) {
    issues.push(issue(envelope, "workflow_stage", "workflow_stage_not_rendered", "The canonical workflow stage must be rendered."));
  }
  if (!envelope.subject.includes(envelope.language === "ko"
    ? EVENT_TEXT[envelope.workflowKey].subjectKo
    : EVENT_TEXT[envelope.workflowKey].subjectJa)) {
    issues.push(issue(envelope, "purpose", "notification_purpose_missing", "Subject must state the workflow purpose."));
  }
  if (!envelope.purpose.text.trim() || !envelope.body.includes(envelope.purpose.text)) {
    issues.push(issue(envelope, "action_or_purpose", "explicit_purpose_missing", "An exact requested action or informational purpose is required."));
  }

  const allowlist = new Set(FILM_ORDER_LINK_ALLOWLISTS[envelope.audience]);
  const linksByKey = new Map(envelope.links.map((link) => [link.key, link]));
  for (const link of envelope.links) {
    if (!allowlist.has(link.key)) {
      issues.push(issue(envelope, "required_link", "link_audience_forbidden", `Link ${link.key} is forbidden for ${envelope.audience}.`));
    }
    try {
      const parsed = new URL(link.url);
      if (!["http:", "https:"].includes(parsed.protocol) || /\s/u.test(link.url) || link.url.length > 2048) {
        throw new Error("invalid_workflow_link_url");
      }
    } catch {
      issues.push(issue(envelope, "required_link", "link_url_invalid", `Link ${link.key} must have a valid http(s) URL.`));
    }
  }
  for (const requiredKey of REQUIRED_LINKS[envelope.workflowKey][envelope.audience] ?? []) {
    const link = linksByKey.get(requiredKey);
    if (!link || !envelope.body.includes(link.url)) {
      issues.push(issue(envelope, "required_link", "required_link_missing", `Required link ${requiredKey} is missing or not rendered.`));
    }
  }
  for (const match of content.match(URL_PATTERN) ?? []) {
    if (!envelope.links.some((link) => link.url === match)) {
      issues.push(issue(envelope, "required_link", "untyped_link_forbidden", "Raw URLs must be typed links in the envelope."));
    }
  }

  const expectedLanguage = envelope.audience === "maker"
    ? envelope.language
    : "ja";
  if (envelope.language !== expectedLanguage || !["ja", "ko"].includes(envelope.language)) {
    issues.push(issue(envelope, "language", "notification_language_invalid", "Maker language must match the selected maker; other audiences are Japanese."));
  }
  if (!envelope.nextStep.trim() || !envelope.body.includes(envelope.nextStep)) {
    issues.push(issue(envelope, "next_step", "next_step_missing", "A rendered deadline or next-step expectation is required."));
  }

  const confidential = envelope.audience === "seven" || envelope.audience === "customer";
  if (confidential) {
    if (containsValue(content, disclosureContext.makerCompanyName)) {
      issues.push(issue(envelope, "disclosure", "maker_identity_disclosure_forbidden", "Maker identity must not be disclosed to Seven or the customer."));
    }
    if (containsValue(content, disclosureContext.makerContact)) {
      issues.push(issue(envelope, "disclosure", "maker_contact_disclosure_forbidden", "Maker contact details must not be disclosed to Seven or the customer."));
    }
  }
  if (envelope.audience === "customer" && containsValue(content, disclosureContext.purchaseOrderNumber)) {
    issues.push(issue(envelope, "disclosure", "internal_po_disclosure_forbidden", "Internal purchase order details must not be disclosed to the customer."));
  }
  if (envelope.audience !== "kanei" && containsValue(content, disclosureContext.internalCostSummary)) {
    issues.push(issue(envelope, "disclosure", "internal_cost_disclosure_forbidden", "Internal cost data is allowed only for Kanei."));
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

export function buildFilmOrderNotifications(
  event: FilmOrderNotificationEvent,
  input: FilmOrderNotificationInput,
): FilmOrderNotificationBuildResult {
  const errors: FilmOrderNotificationIssue[] = [];
  const envelopes: FilmOrderNotificationEnvelope[] = [];
  const audiences = expectedFilmOrderNotificationAudiences(event, input);
  if (event === "link_resend" && audiences.length === 0) {
    errors.push({ point: "recipient", code: "link_resend_audience_missing", message: "Link resend requires at least one allowed audience." });
  }

  for (const audience of audiences) {
    const to = input.recipients[audience]?.trim() ?? "";
    const sender = input.senderIdentity[audience]?.trim() ?? "";
    if (audience === "maker") {
      if (!input.maker?.language || !["ja", "ko"].includes(input.maker.language)) {
        errors.push({ audience, point: "language", code: "maker_language_missing", message: "Selected maker language is required." });
      }
      if (!input.maker?.email && !to) {
        errors.push({ audience, point: "recipient", code: "maker_recipient_missing", message: "Selected maker recipient is required." });
      }
    }
    if (!to || !EMAIL_PATTERN.test(to)) {
      errors.push({ audience, point: "recipient", code: "intended_recipient_missing", message: `Intended recipient for ${audience} is required.` });
    }
    if (!sender) {
      errors.push({ audience, point: "sender_identity", code: "sender_identity_missing", message: `Sender identity for ${audience} is required.` });
    }
    const senderEmail = input.senderEmail.trim();
    if (!senderEmail || !EMAIL_PATTERN.test(senderEmail)) {
      errors.push({ audience, point: "sender_identity", code: "smtp_sender_address_missing", message: "Effective SMTP sender address is required." });
    }

    const language = localeFor(audience, input.maker);
    const links = normalizedLinksForAudience(event, audience, input.links);
    const template = templateForProjection(event, audience, input.overrides);
    const defaultSubjectText = defaultSubject(event, language, input);
    const defaultBodyText = defaultBody(event, audience, input, links);
    const subject = template.override?.subject
      ? interpolateFilmOrderNotificationTemplate(template.override.subject, bodyVariables(event, audience, input))
      : defaultSubjectText;
    const body = template.override?.body?.trim()
      ? interpolateFilmOrderNotificationTemplate(template.override.body, bodyVariables(event, audience, input))
      : defaultBodyText.body;
    const ccSource = template.override?.cc ?? input.cc?.[audience] ?? [];
    const cc = [...new Set(ccSource.map((address) => address.trim()).filter(Boolean))];
    const purposeText = defaultBodyText.purposeText;
    const candidate: Omit<FilmOrderNotificationEnvelope, "contentHash"> = {
      orderId: input.orderId,
      dispatchGroupId: input.dispatchGroupId,
      orderNumber: input.orderNumber,
      productName: input.productName,
      productSpecification: input.productSpecification,
      workflowKey: event,
      workflowStage: input.workflowStage,
      audience,
      language,
      templateKey: template.key,
      effectiveTemplateIdentity: {
        key: template.key,
        source: template.override ? "override" : "default",
        compatibilityKey: template.compatibilityKey,
        bindingFingerprint: input.bindingFingerprint?.trim() || "default",
      },
      senderIdentity: sender,
      senderEmail,
      intendedTo: to,
      cc,
      subject,
      body,
      links,
      attachments: [...(input.attachments ?? [])],
      purpose: {
        kind: ACTION_AUDIENCES[event].includes(audience) ? "action" : "informational",
        text: purposeText,
      },
      nextStep: defaultBodyText.nextStep,
      deadlineAt: input.deadlineAt ?? null,
    };
    const disclosureContext = disclosureInputFields(input);
    const envelope: FilmOrderNotificationEnvelope = {
      ...candidate,
      contentHash: filmOrderNotificationEnvelopeHash(candidate),
    };
    const validation = validateFilmOrderNotification(envelope, disclosureContext);
    if (validation.ok) envelopes.push(envelope);
    else errors.push(...validation.issues);
  }

  return errors.length === 0
    ? { ok: true, envelopes }
    : { ok: false, envelopes: [], errors };
}

function disclosureInputFields(input: FilmOrderNotificationInput): {
  makerCompanyName?: string;
  makerContact?: string;
  purchaseOrderNumber?: string;
  internalCostSummary?: string;
} {
  return {
    ...(input.maker?.companyName ? { makerCompanyName: input.maker.companyName } : {}),
    ...(input.maker?.contactName || input.maker?.email
      ? { makerContact: [input.maker.contactName, input.maker.email].filter(Boolean).join(" ") }
      : {}),
    ...(input.purchaseOrderNumber ? { purchaseOrderNumber: input.purchaseOrderNumber } : {}),
    ...(input.internalCostSummary ? { internalCostSummary: input.internalCostSummary } : {}),
  };
}
