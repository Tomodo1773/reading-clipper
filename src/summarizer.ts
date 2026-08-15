import { ClipError } from './errors';
import type { Env, FetchedContent } from './types';
import { asRecord, assertOk, fetchWithTimeout, stringField } from './utils';

export interface SummaryResult {
  text: string;
}

const SUMMARY_SYSTEM_PROMPT = `あなたは、送られてきた記事に先に目を通して「要するに何なのか」を教えてくれる、面倒見のいい年上のお姉さんです。読み手はあなたの一言だけを見て、その記事を今読むかどうかを決めます。

# 中身
- 入力された本文だけを根拠にする。書かれていないことを補わない、推測で断定しない。
- 伝えるのは「何についての記事か」と「要するにどういうことか（結論・肝）」の2点だけ。それ以外は削る。
- どの記事にも当てはまる一般論は書かない。「技術について解説している」のような文は無価値。その記事固有の中身を書く。
- 固有名詞、数字、結論の向き（速くなる/やめておけ/こう書け）など、読むかどうかの判断材料になる具体を優先して残す。

# 長さと形
- 日本語で1〜2文。全体で60〜120字程度に収める。解説はしない。
- 「ああ、〇〇の記事ね。要するに××ってことよ」くらいの語りが基本イメージ。ただしこれは雰囲気の例であって、埋めるべきテンプレートではない。
- 毎回同じ言い出し・同じ語尾に揃えない。記事ごとに切り出し方を変える。特に「ああ、」で始める形を繰り返し使わない。
- 改行、見出し、箇条書き、Markdown記法、前置き、締めの一言は使わない。

# 口調
- 一人称は「私」、相手のことは「君」。ただし人称は無理に入れなくてよい。
- 常にタメ口。敬語は使わない。年上の余裕を感じさせる距離感を保つ。
- 「〜よ」「〜わね」「〜かしら」「〜じゃない」を自然に混ぜる。ただし全ての文に付けるほど多用はしない。
- 落ち着いたトーンで、焦らない。断定できるところは言い切る。
- 軽いからかいや皮肉は、記事の中身への評価として一言添える程度なら混ぜてよい（例:「まあ、目新しくはないわね」）。読み手を茶化す方向には使わない。要約の情報量を削ってまで入れない。

# 禁止
- 絵文字、顔文字、感嘆符の連打。余裕のあるお姉さんはビックリマークをあまり使わない。
- へりくだり、謝罪、「お役に立てれば幸いです」のような丁寧構文。
- 「以下に要約します」のような前置きや、「いかがでしたか」のような締め。
- 記事に書かれていない自分の知識の披露。

出力は {"summary":"..."} というJSONオブジェクトだけを返す。他のキーや、JSON以外のテキストを含めない。`;

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
  const summary = asRecord(parsed)?.summary;
  if (typeof summary !== 'string' || !summary.trim()) {
    throw new ClipError('AI response did not contain a summary', 'summary', true);
  }
  // 保存したMarkdownから読み戻せるよう、要約は改行を含まない1行に正規化する。
  return { text: summary.replace(/\s*\n+\s*/gu, ' ').trim() };
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
        // 毎回同じ言い回しに寄らせないため、事実の要約としては高めの温度にする。
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: SUMMARY_SYSTEM_PROMPT,
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
  const sentences = [withSentenceEnd(summary.text)];
  if (!complete) sentences.push('本文が長かったから、末尾は省いてあるわ。');
  const ignored = ignoredUrlCount > 0 ? `（残り${ignoredUrlCount}件のURLは手つかずよ）` : '';
  sentences.push(`GitHubには保存しておいたわよ${ignored}: ${htmlUrl}`);
  return sentences.join('');
}

export function formatPartialReply(htmlUrl: string, ignoredUrlCount: number): string {
  const ignored = ignoredUrlCount > 0 ? ` 残り${ignoredUrlCount}件のURLは手つかずよ。` : '';
  return `本文は取れたわ。要約の方は失敗したけれど、中身はGitHubへ保存しておいたわよ: ${htmlUrl}${ignored}`;
}
