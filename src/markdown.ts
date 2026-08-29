import type { FetchedContent } from './types';

function frontMatterValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

/**
 * フロントマターの直下に本文を置く、保存するMarkdownの形。
 *
 * 値は書く側が整えて渡す。翻訳で書き戻すときは読んだ値をそのまま並べ直すため、
 * ここでは項目を解釈しない（ADR 0027）。
 */
export function renderMarkdown(fields: Array<[string, string]>, body: string): string {
  const frontMatter = fields.map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${frontMatter}\n---\n\n${body.trim()}\n`;
}

/** 取得した本文を、そのまま保存する形へ組み立てる。 */
export function renderClipMarkdown(content: FetchedContent, clippedAt: string): string {
  const fields: Array<[string, string | boolean | undefined]> = [
    ['source_url', content.canonicalUrl],
    ['source_type', content.source],
    ['title', content.title],
    ['author', content.author],
    ['published_at', content.publishedAt],
    ['source_version', content.version],
    // D1が失われても再構成できるよう、正本のGitHub側にも残す（ADR 0011）。
    ['image_url', content.imageUrl],
    ['clipped_at', clippedAt],
    ['fetch_complete', content.complete],
  ];
  return renderMarkdown(
    fields
      .filter((field): field is [string, string | boolean] => field[1] !== undefined)
      .map(([key, value]) => [key, frontMatterValue(value)]),
    content.markdown,
  );
}
