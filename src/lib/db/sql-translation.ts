/**
 * SQLite 形式で書かれた SQL を PostgreSQL 向けに変換する。
 *
 * - `?` プレースホルダーを `$1, $2, ...` に変換する
 * - `LIKE` を `ILIKE` に変換して SQLite と同じ大小文字を区別しない検索に揃える
 * - 文字列リテラル・引用識別子・コメント内は変換しない
 */
export function translateSqlToPostgres(sql: string): string {
  let result = "";
  let position = 0;
  let parameterIndex = 0;

  const appendRange = (start: number, end: number) => {
    result += sql.slice(start, end);
  };

  const isIdentifierStart = (char: string | undefined) => !!char && /[A-Za-z_\u0080-\uffff]/.test(char);
  const isIdentifierPart = (char: string | undefined) => !!char && /[A-Za-z0-9_$\u0080-\uffff]/.test(char);

  while (position < sql.length) {
    const char = sql[position];
    if (!char) break;

    // 行コメント
    if (char === "-" && sql[position + 1] === "-") {
      const end = sql.indexOf("\n", position);
      const stop = end === -1 ? sql.length : end + 1;
      appendRange(position, stop);
      position = stop;
      continue;
    }

    // ブロックコメント
    if (char === "/" && sql[position + 1] === "*") {
      const end = sql.indexOf("*/", position + 2);
      const stop = end === -1 ? sql.length : end + 2;
      appendRange(position, stop);
      position = stop;
      continue;
    }

    // 文字列リテラル・引用識別子
    if (char === "'" || char === '"' || char === "`") {
      let cursor = position + 1;
      while (cursor < sql.length) {
        const current = sql[cursor];
        if (current === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      appendRange(position, cursor);
      position = cursor;
      continue;
    }

    // ドル引用文字列（$tag$ ... $tag$）
    if (char === "$") {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(position));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, position + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        appendRange(position, stop);
        position = stop;
        continue;
      }
    }

    if (char === "?") {
      parameterIndex += 1;
      result += `$${parameterIndex}`;
      position += 1;
      continue;
    }

    if (isIdentifierStart(char)) {
      let cursor = position + 1;
      while (cursor < sql.length && isIdentifierPart(sql[cursor])) cursor += 1;
      const word = sql.slice(position, cursor);
      result += word.toUpperCase() === "LIKE" ? "ILIKE" : word;
      position = cursor;
      continue;
    }

    result += char;
    position += 1;
  }

  return result;
}
