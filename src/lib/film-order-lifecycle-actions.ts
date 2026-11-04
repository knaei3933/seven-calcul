export const FILM_ORDER_LIFECYCLE_WORKFLOW_ACTIONS = [
  "register-receiving",
  "send-proof-notice",
  "rotate-supplier-proof-token",
  "register-proof",
  "send-customer-proof-review",
  "record-customer-proof-approval",
  "approve",
  "request-re-proof",
  "send-po",
  "resend-supplier-links",
  "resend-receiving-notice",
  "request-production-plan",
  "request-ship-to-registration",
  "ship-to-registered",
  "request-customer-design-upload",
  "request-customer-design-correction",
  "customer-design-received",
  "production-plan-request",
  "update-eta",
  "report-shipment",
  "report-delivery",
  "confirm-film-receipt",
  "customer-proof-decision",
] as const;

export type FilmOrderLifecycleWorkflowAction = typeof FILM_ORDER_LIFECYCLE_WORKFLOW_ACTIONS[number];

export function isFilmOrderLifecycleWorkflowAction(action: string): action is FilmOrderLifecycleWorkflowAction {
  return (FILM_ORDER_LIFECYCLE_WORKFLOW_ACTIONS as readonly string[]).includes(action);
}
