import {
  FILM_ORDER_INTAKE_DUAL_APPROVAL_FILTERS,
  FILM_ORDER_INTAKE_MAKER_FILTERS,
  FILM_ORDER_INTAKE_PO_FILTERS,
  FILM_ORDER_INTAKE_PROOF_FILTERS,
  FILM_ORDER_INTAKE_STATE_FILTERS,
  FILM_ORDER_INTAKE_OWNER_FILTERS,
  type FilmOrderIntakeQuery,
} from "@/lib/film-order-intake";

function boundedValue<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((item) => item === value);
}

export function parseIntakeQuery(url: URL): FilmOrderIntakeQuery | null {
  const params = url.searchParams;
  const owner = boundedValue(params.get("owner"), FILM_ORDER_INTAKE_OWNER_FILTERS);
  const intakeState = boundedValue(params.get("intakeState"), FILM_ORDER_INTAKE_STATE_FILTERS);
  const makerHandoff = boundedValue(params.get("makerHandoff"), FILM_ORDER_INTAKE_MAKER_FILTERS);
  const proof = boundedValue(params.get("proof"), FILM_ORDER_INTAKE_PROOF_FILTERS);
  const dualApproval = boundedValue(
    params.get("dualApproval"),
    FILM_ORDER_INTAKE_DUAL_APPROVAL_FILTERS,
  );
  const po = boundedValue(params.get("po"), FILM_ORDER_INTAKE_PO_FILTERS);
  const rawPage = params.get("page") ?? "";
  const rawPageSize = params.get("pageSize") ?? "";
  const page = rawPage === "" ? 1 : Number(rawPage);
  const pageSize = rawPageSize === "" ? 20 : Number(rawPageSize);
  if (
    !Number.isInteger(page) || page < 1
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
  ) return null;

  return {
    search: params.get("search") ?? undefined,
    owner,
    intakeState,
    makerHandoff,
    proof,
    dualApproval,
    po,
    page,
    pageSize,
  };
}
