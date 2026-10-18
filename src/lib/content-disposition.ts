export function fileNameFromContentDisposition(header: string, fallback: string): string {
  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    try {
      const fileName = decodeURIComponent(encodedMatch[1]).trim();
      if (fileName) return fileName;
    } catch {
      // A malformed encoded value falls back to the caller-known safe name.
    }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim() || fallback;
}
