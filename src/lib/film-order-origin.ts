const URL_PATTERN = /^https?:\/\//iu;

export class FilmOrderOriginNotAllowedError extends Error {
  constructor() {
    super("film_order_external_origin_not_allowed");
    this.name = "FilmOrderOriginNotAllowedError";
  }
}

/** Deployment-owned exact origins; forwarded headers and production fallbacks are never trusted. */
export function filmOrderExternalLinkOrigins(): string[] {
  const configured = [
    process.env.FILM_EXTERNAL_LINK_ORIGINS,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(configured.map((value) => value.replace(/\/$/, "")))];
  for (const origin of unique) {
    try {
      const parsed = new URL(origin);
      if (!URL_PATTERN.test(origin) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new FilmOrderOriginNotAllowedError();
      }
    } catch (error) {
      if (error instanceof FilmOrderOriginNotAllowedError) throw error;
      throw new FilmOrderOriginNotAllowedError();
    }
  }
  return unique;
}

export function isAllowedFilmOrderExternalOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  const normalized = origin.replace(/\/$/, "");
  try {
    const parsed = new URL(normalized);
    if (!URL_PATTERN.test(normalized) || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  } catch {
    return false;
  }
  return filmOrderExternalLinkOrigins().includes(normalized);
}

export function resolveFilmOrderExternalOrigin(requestedOrigin?: unknown): string {
  if ((requestedOrigin == null || requestedOrigin === "") && process.env.FILM_DEFAULT_EXTERNAL_LINK_ORIGIN) {
    return resolveFilmOrderExternalOrigin(process.env.FILM_DEFAULT_EXTERNAL_LINK_ORIGIN);
  }
  const defaultOrigin = process.env.FILM_DEFAULT_EXTERNAL_LINK_ORIGIN?.replace(/\/$/, "");
  if (filmOrderExternalLinkOrigins().length === 0 && typeof requestedOrigin === "string" && requestedOrigin.replace(/\/$/, "") === defaultOrigin) {
    return defaultOrigin!;
  }
  if (!isAllowedFilmOrderExternalOrigin(requestedOrigin)) throw new FilmOrderOriginNotAllowedError();
  return (requestedOrigin as string).replace(/\/$/, "");
}
