/**
 * ダイジェストでタイトルの下に出す抜粋を作る（ADR 0011）。
 *
 * Worker側（保存時）とNode側（バックフィル）の両方から呼ぶため、このモジュールは
 * 何もimportしない。同じ本文からは必ず同じ結果が出る必要があり、片方だけ実装が
 * 変わると、保存し直した記事とそうでない記事で抜粋の作り方が食い違う。
 */

/** ダイジェストの1行に収まる長さ。これ以上は読まずに記事を開いたほうが早い。 */
const EXCERPT_CHARS = 100;

export function clipExcerpt(markdown: string): string {
  const text = markdown
    // 本文がフロントマターで始まるクリップがある（Qiitaの`.md`は原稿ごと保存されている）。
    // 区切りだけ落とすと`title:`や`tags:`が抜粋の先頭に居座る。
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ' ')
    // コードブロックは切り詰めると読めないので、丸ごと落とす。
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
    .replace(/^\s{0,3}>\s?/gm, ' ')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= EXCERPT_CHARS) return text;
  let head = text.slice(0, EXCERPT_CHARS);
  // 切り口がサロゲートペアの途中だと、壊れた文字が末尾に残る。
  if (/\p{Surrogate}$/u.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}
