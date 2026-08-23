/** フロントマターと、それを除いた本文。 */
export interface FrontMatter {
  fields: Record<string, string>;
  body: string;
}

/** 先頭のフロントマターだけを、値を解釈せずに読む。 */
export function splitFrontMatter(source: string): FrontMatter {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (field?.[1]) fields[field[1]] = (field[2] ?? '').trim();
  }
  return { fields, body: source.slice(match[0].length) };
}

/** `renderClipMarkdown`がJSON文字列として書いた値を元へ戻す。 */
export function parseClipFrontMatter(source: string): FrontMatter {
  const { fields, body } = splitFrontMatter(source);
  for (const [key, raw] of Object.entries(fields)) {
    if (!raw.startsWith('"')) continue;
    try {
      fields[key] = String(JSON.parse(raw));
    } catch {
      // 壊れた値は素のまま残し、読めた項目だけを使う。
    }
  }
  return { fields, body };
}
