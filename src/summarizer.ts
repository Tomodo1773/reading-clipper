import { ClipError } from './errors';
import type { Env, FetchedContent } from './types';
import { asRecord, assertOk, fetchWithTimeout, stringField } from './utils';

export interface SummaryResult {
  sentences: [string, string];
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

export function parseSummaryResponse(value: string): SummaryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(value));
  } catch (error) {
    throw new ClipError('AI response was not valid JSON', 'summary', true, undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const sentences = asRecord(parsed)?.sentences;
  if (
    !Array.isArray(sentences) ||
    sentences.length !== 2 ||
    !sentences.every((sentence) => typeof sentence === 'string' && sentence.trim())
  ) {
    throw new ClipError('AI response did not contain exactly two sentences', 'summary', true);
  }
  return { sentences: [sentences[0].trim(), sentences[1].trim()] };
}

export async function summarizeContent(
  content: FetchedContent,
  env: Env,
): Promise<SummaryResult> {
  const response = await fetchWithTimeout(
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/${encodeURIComponent(env.AI_GATEWAY_ID)}/compat/chat/completions`,
    {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: `google-ai-studio/${env.AI_MODEL}`,
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'あなたは技術記事の要約者です。入力だけを根拠に、日本語で自然な2文を作ります。1文目はテーマと主な結論、2文目は結論に至る主要な内容を述べてください。見出し、箇条書き、前置き、Markdownを使わず、必ず {"sentences":["...","..."]} だけを返してください。',
          },
          {
            role: 'user',
            content: `タイトル: ${content.title}\nURL: ${content.canonicalUrl}\n本文:\n${content.markdown}`,
          },
        ],
      }),
    },
    60_000,
    'summary',
  );
  assertOk(response, 'summary');
  const root = asRecord(await response.json());
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const text = stringField(message, 'content');
  if (!text) throw new ClipError('AI response contained no text', 'summary', true);
  return parseSummaryResponse(text);
}

function withSentenceEnd(value: string): string {
  const trimmed = value.trim();
  return /[。！？!?]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}

export function formatSuccessReply(
  summary: SummaryResult,
  complete: boolean,
  htmlUrl: string,
  ignoredUrlCount: number,
): string {
  const sentences = summary.sentences.map(withSentenceEnd);
  if (!complete) sentences.push('取得内容が長かったため、末尾を省略しているよ。');
  const ignored = ignoredUrlCount > 0 ? `（残り${ignoredUrlCount}件のURLは未処理）` : '';
  sentences.push(`GitHubへの保存に成功したよ${ignored}: ${htmlUrl}`);
  return sentences.join('');
}

export function formatPartialReply(htmlUrl: string, ignoredUrlCount: number): string {
  const ignored = ignoredUrlCount > 0 ? ` 残り${ignoredUrlCount}件のURLは処理していないよ。` : '';
  return `本文の取得には成功したよ。AI要約には失敗したけれど、本文はGitHubへ保存したよ: ${htmlUrl}${ignored}`;
}
