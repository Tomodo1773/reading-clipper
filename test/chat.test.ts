import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatTurn } from '../src/chat';
import { resetGitHubTokenCache } from '../src/github';
import { base64ToUtf8 } from '../src/utils';
import { generatePrivateKeyPem, jsonResponse, makeEnv, modelResponse } from './helpers';

const RECEIVED_AT = '2026-08-15T00:00:00.000Z';
const ARTICLE = '---\ntitle: Worker設計\nauthor: alice\n---\n## 概要\n\nQueueで重い処理を分離する。';

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  privateKeyPem = await generatePrivateKeyPem();
});

afterEach(() => vi.restoreAllMocks());

interface Recorded {
  modelBodies: Record<string, unknown>[];
  savedPath: string;
  savedMarkdown: string;
}

/**
 * `modelReplies` はモデルが呼ばれた順に返す応答。
 * 記事の取得とGitHubは実物のコードを通す。
 */
function mockWorld(modelReplies: Response[]): Recorded {
  const recorded: Recorded = { modelBodies: [], savedPath: '', savedMarkdown: '' };
  let modelCall = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/app/installations/') && method === 'POST') {
      return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
    }
    if (url === 'https://qiita.com/alice/items/abc.md') {
      return new Response(ARTICLE, { status: 200 });
    }
    if (url.includes(':generateContent')) {
      recorded.modelBodies.push(JSON.parse(String(init?.body)));
      const reply = modelReplies[modelCall];
      modelCall += 1;
      if (!reply) throw new Error(`unexpected model call #${modelCall}`);
      return reply;
    }
    if (url.includes('/repos/example/clips/contents/') && method === 'GET') {
      return jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url.includes('/repos/example/clips/contents/') && method === 'PUT') {
      recorded.savedPath = decodeURIComponent(url.split('/contents/')[1] ?? '');
      recorded.savedMarkdown = base64ToUtf8(JSON.parse(String(init?.body)).content);
      return jsonResponse(
        { content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/clip.md' } },
        201,
      );
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return recorded;
}

/** ツール結果のメッセージから、save_clipが返した値そのものを取り出す。 */
function toolOutput(messages: ModelMessage[]): Record<string, unknown> {
  const toolMessage = messages.find((message) => message.role === 'tool');
  const parts = toolMessage?.content as
    | Array<{ output: { value: Record<string, unknown> } }>
    | undefined;
  const first = parts?.[0];
  if (!first) throw new Error('tool result was not appended to the conversation');
  return first.output.value;
}

/** Gemini 3系はfunctionCallにthoughtSignatureを添えて返す。 */
function toolCallReply(url: string): Response {
  return modelResponse([
    {
      functionCall: { name: 'save_clip', args: { url } },
      thoughtSignature: 'sig-abc',
    },
  ]);
}

/** Geminiがサーバー側で検索を実行したときの応答。1回のgenerateContentに全部入る。 */
function groundedReply(text: string): Response {
  return modelResponse(
    [
      {
        toolCall: { toolType: 'google_search', id: 'search-1', args: { queries: ['hono latest'] } },
        thoughtSignature: 'sig-search',
      },
      {
        toolResponse: {
          toolType: 'google_search',
          id: 'search-1',
          response: { results: [{ title: 'Hono', snippet: 'v4' }] },
        },
      },
      { text },
    ],
    {
      groundingMetadata: {
        webSearchQueries: ['hono latest'],
        groundingChunks: [
          {
            web: {
              uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
              title: 'hono.dev',
            },
          },
        ],
      },
    },
  );
}

describe('chat turn', () => {
  it('saves through the tool and answers from the body it returned', async () => {
    const recorded = mockWorld([
      toolCallReply('https://qiita.com/alice/items/abc'),
      modelResponse([
        {
          text: 'Workerの非同期処理の話ね。要するに重い処理はQueueへ分けなさい、ってことよ。<https://github.com/example/clips/blob/main/clip.md|GitHub>には置いておいたわ。',
        },
      ]),
    ]);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://qiita.com/alice/items/abc',
      receivedAt: RECEIVED_AT,
    });

    // 保存はADR 0005のまま。要約はファイルに入れない。
    expect(recorded.savedPath).toBe('clips/qiita.com/Worker設計.md');
    expect(recorded.savedMarkdown).toContain('## 概要\n\nQueueで重い処理を分離する。');
    expect(recorded.savedMarkdown).not.toContain('要するに重い処理はQueueへ分けなさい');

    // ツール結果には保存の事実と本文がそのまま入る。切り詰めない。
    const result = toolOutput(turn.appended);
    expect(result.saved).toBe(true);
    expect(result.github_url).toBe('https://github.com/example/clips/blob/main/clip.md');
    expect(String(result.body)).toContain('Queueで重い処理を分離する。');

    expect(turn.reply).toContain('要するに重い処理はQueueへ分けなさい');

    // user / assistant(tool call) / tool / assistant(text)
    expect(turn.appended.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('keeps the thought signature in history and sends it back on the next turn', async () => {
    mockWorld([
      toolCallReply('https://qiita.com/alice/items/abc'),
      modelResponse([{ text: '保存しておいたわ。' }]),
    ]);

    const first = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://qiita.com/alice/items/abc',
      receivedAt: RECEIVED_AT,
    });

    // 落とすと次のリクエストが400になるため、履歴に残っている必要がある（ADR 0008）。
    // Durable Objectへ入るのはJSONなので、往復させてから確かめる。
    const stored = first.appended.map(
      (message) => JSON.parse(JSON.stringify(message)) as ModelMessage,
    );
    const assistantParts = stored[1]?.content as
      | Array<{ type: string; providerOptions?: Record<string, unknown> }>
      | undefined;
    const toolCallPart = assistantParts?.find((part) => part.type === 'tool-call');
    expect(toolCallPart?.providerOptions?.google).toEqual({ thoughtSignature: 'sig-abc' });

    const recorded = mockWorld([modelResponse([{ text: 'Queueの話が中心よ。' }])]);
    await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: stored,
      userText: 'ここには何が書いてあるの？',
      receivedAt: RECEIVED_AT,
    });

    expect(JSON.stringify(recorded.modelBodies[0])).toContain('sig-abc');
  });

  it('answers a follow-up from stored history without calling the tool again', async () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'https://qiita.com/alice/items/abc' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'save_clip',
            input: { url: 'https://qiita.com/alice/items/abc' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'save_clip',
            output: { type: 'json', value: { saved: true, title: 'Worker設計', body: ARTICLE } },
          },
        ],
      },
      { role: 'assistant', content: '要するに重い処理はQueueへ分けなさい、ってことよ。' },
    ];
    const recorded = mockWorld([modelResponse([{ text: 'Queueで受け付けと処理を分ける話が中心よ。' }])]);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history,
      userText: 'ここには何が書いてあるの？',
      receivedAt: RECEIVED_AT,
    });

    expect(turn.appended.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(turn.reply).toBe('Queueで受け付けと処理を分ける話が中心よ。');
    // 記事の再取得もGitHubへの読み書きも起きない。
    expect(recorded.savedPath).toBe('');
    // 過去のツール結果は本文ごとモデルへ渡る。
    expect(JSON.stringify(recorded.modelBodies[0])).toContain('Queueで重い処理を分離する。');
  });

  it('finishes a grounded answer in a single model call', async () => {
    // 検索はGemini側で実行され、同じ応答にtoolCall/toolResponseとして載る。
    // providerExecutedなのでAI SDKのループは回らず、stepを消費しない。
    const recorded = mockWorld([groundedReply('Hono v4が最新よ。Honoの公式ドキュメントに出ていたわ。')]);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'Honoの最新バージョンっていくつ？',
      receivedAt: RECEIVED_AT,
    });

    expect(recorded.modelBodies).toHaveLength(1);
    expect(turn.reply).toContain('Hono v4が最新よ');
    expect(turn.appended.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('sends google_search and save_clip together with VALIDATED tool config', async () => {
    // Gemini 3世代でしか併用は成立しない。AI_MODELを2.x系へ落とすとsave_clipが黙って消えるため、
    // 実行時チェックの代わりにここで検出する。
    const recorded = mockWorld([modelResponse([{ text: 'そうね。' }])]);

    await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'おはよう',
      receivedAt: RECEIVED_AT,
    });

    const body = recorded.modelBodies[0] as {
      tools?: Array<Record<string, unknown>>;
      toolConfig?: { functionCallingConfig?: { mode?: string } };
    };
    expect(body.tools?.some((entry) => 'googleSearch' in entry)).toBe(true);
    const functionTools = body.tools?.find((entry) => 'functionDeclarations' in entry) as
      | { functionDeclarations: Array<{ name: string }> }
      | undefined;
    expect(functionTools?.functionDeclarations.map((declaration) => declaration.name)).toContain(
      'save_clip',
    );
    expect(body.toolConfig?.functionCallingConfig?.mode).toBe('VALIDATED');
  });

  it('keeps grounded tool parts in history and sends them back on the next turn', async () => {
    mockWorld([groundedReply('Hono v4が最新よ。')]);

    const first = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'Honoの最新バージョンっていくつ？',
      receivedAt: RECEIVED_AT,
    });

    // Durable Objectへ入るのはJSON。往復させてから次のターンへ渡す。
    const stored = first.appended.map(
      (message) => JSON.parse(JSON.stringify(message)) as ModelMessage,
    );

    const recorded = mockWorld([modelResponse([{ text: 'ええ、さっき調べたとおりよ。' }])]);
    await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: stored,
      userText: 'ほんとに？',
      receivedAt: RECEIVED_AT,
    });

    const modelTurn = (
      recorded.modelBodies[0] as { contents: Array<{ role: string; parts: unknown[] }> }
    ).contents.find((content) => content.role === 'model');
    const parts = (modelTurn?.parts ?? []) as Array<{
      toolCall?: { toolType: string; id: string };
      toolResponse?: { toolType: string; id: string };
      thoughtSignature?: string;
    }>;
    expect(parts.find((part) => part.toolCall)?.toolCall).toMatchObject({
      toolType: 'google_search',
      id: 'search-1',
    });
    // server tool call側の署名も往復する。落とすとfunctionCall版と同じくHTTP 400になる（ADR 0008）。
    expect(parts.find((part) => part.toolCall)?.thoughtSignature).toBe('sig-search');
    expect(parts.find((part) => part.toolResponse)?.toolResponse).toMatchObject({
      toolType: 'google_search',
      id: 'search-1',
    });
  });

  it('reports a permanent fetch failure as tool data instead of saving', async () => {
    let putCalled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes(':generateContent')) {
        const body = JSON.parse(String(init?.body));
        const hasToolResult = JSON.stringify(body).includes('functionResponse');
        return hasToolResult
          ? modelResponse([{ text: '中身が取れなかったわ。今回は何も残していないわよ。' }])
          : toolCallReply('https://qiita.com/alice/items/gone');
      }
      if (url === 'https://qiita.com/alice/items/gone.md') return jsonResponse({}, 404);
      if (method === 'PUT') {
        putCalled = true;
        return jsonResponse({}, 201);
      }
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 't', expires_at: '2099-01-01T00:00:00Z' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://qiita.com/alice/items/gone これ保存して',
      receivedAt: RECEIVED_AT,
    });

    expect(toolOutput(turn.appended)).toEqual({ saved: false, failed_at: 'fetch' });
    expect(putCalled).toBe(false);
    expect(turn.reply).toContain('何も残していない');
  });
});
