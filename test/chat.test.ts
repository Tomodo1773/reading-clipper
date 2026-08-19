import type { ModelMessage } from 'ai';
import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatTurn } from '../src/chat';
import { recordClip } from '../src/clips';
import { ClipError } from '../src/errors';
import { resetGitHubTokenCache } from '../src/github';
import { base64ToUtf8 } from '../src/utils';
import {
  generatePrivateKeyPem,
  htmlResponse,
  jsonResponse,
  makeEnv,
  modelResponse,
  resetClips,
} from './helpers';

const RECEIVED_AT = '2026-08-15T00:00:00.000Z';
const ARTICLE = '---\ntitle: Worker設計\nauthor: alice\n---\n## 概要\n\nQueueで重い処理を分離する。';

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  await resetClips();
  privateKeyPem = await generatePrivateKeyPem();
});

afterEach(() => vi.restoreAllMocks());

interface Recorded {
  modelBodies: Record<string, unknown>[];
  savedPath: string;
  savedMarkdown: string;
  /** PUTに載ったsha。新規作成なら空のまま。 */
  savedSha: string;
  /** 本文の取得が何回走ったか。ロードと保存で二重に取っていないことを見る。 */
  articleFetches: number;
  /** GitHubへDELETEが飛んだパス。飛んでいなければ空のまま（ADR 0016）。 */
  deletedPath: string;
  deletedSha: string;
}

/**
 * `modelReplies` はモデルが呼ばれた順に返す応答。
 * 記事の取得とGitHubは実物のコードを通す。
 *
 * `extraRoutes` は既定の経路より先に引く。既定はQiitaの1記事だけを用意しているので、
 * 別のサイトを出したいテストはここへ足す（テストごとに`fetch`の分岐を書き直さない）。
 * GitHubのContents APIは同じURLへGETとDELETEの両方が飛ぶため、メソッドも渡す。
 */
function mockWorld(
  modelReplies: Response[],
  extraRoutes: (url: string, method: string) => Response | undefined = () => undefined,
): Recorded {
  const recorded: Recorded = {
    modelBodies: [],
    savedPath: '',
    savedMarkdown: '',
    savedSha: '',
    articleFetches: 0,
    deletedPath: '',
    deletedSha: '',
  };
  let modelCall = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const extra = extraRoutes(url, method);
    if (extra) return extra;
    if (url.includes('/app/installations/') && method === 'POST') {
      return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
    }
    // load_contentはリダイレクト解決とog:imageのために、記事ページ本体も1回GETする。
    if (url === 'https://qiita.com/alice/items/abc') return htmlResponse('<title>Worker設計</title>');
    if (url === 'https://qiita.com/alice/items/abc.md') {
      recorded.articleFetches += 1;
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
      const body = JSON.parse(String(init?.body));
      recorded.savedPath = decodeURIComponent(url.split('/contents/')[1] ?? '');
      recorded.savedMarkdown = base64ToUtf8(body.content);
      recorded.savedSha = body.sha ?? '';
      return jsonResponse(
        { content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/clip.md' } },
        201,
      );
    }
    if (url.includes('/repos/example/clips/contents/') && method === 'DELETE') {
      recorded.deletedPath = decodeURIComponent(url.split('/contents/')[1] ?? '');
      recorded.deletedSha = JSON.parse(String(init?.body)).sha;
      return jsonResponse({ commit: { sha: 'delete-commit' } });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return recorded;
}

/** 名前で指定したツールが返した値そのものを取り出す。1ターンにツール結果は複数出る。 */
function toolOutput(messages: ModelMessage[], toolName: string): Record<string, unknown> {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const parts = message.content as Array<{
      toolName: string;
      output: { value: Record<string, unknown> };
    }>;
    const found = parts.find((part) => part.toolName === toolName);
    if (found) return found.output.value;
  }
  throw new Error(`${toolName} result was not appended to the conversation`);
}

/** Gemini 3系はfunctionCallにthoughtSignatureを添えて返す。 */
function toolCallReply(name: string, args: Record<string, unknown>): Response {
  return modelResponse([
    {
      functionCall: { name, args },
      thoughtSignature: 'sig-abc',
    },
  ]);
}

const loadCallReply = (url: string): Response => toolCallReply('load_content', { url });
const saveCallReply = (url: string): Response => toolCallReply('save_loaded', { url });
const findCallReply = (query: string): Response => toolCallReply('find_clips', { query });
const deleteCallReply = (ref: number): Response => toolCallReply('delete_clip', { ref });

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
  it('loads first, saves what it loaded, and answers from that body', async () => {
    const recorded = mockWorld([
      loadCallReply('https://qiita.com/alice/items/abc'),
      saveCallReply('https://qiita.com/alice/items/abc'),
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

    // 保存はADR 0005/ADR 0013のまま。要約はファイルに入れない。
    expect(recorded.savedPath).toBe('clips/Worker設計.md');
    expect(recorded.savedMarkdown).toContain('## 概要\n\nQueueで重い処理を分離する。');
    expect(recorded.savedMarkdown).not.toContain('要するに重い処理はQueueへ分けなさい');

    // 本文が会話に現れるのはロードの1回だけ。保存の結果には入れない（ADR 0012）。
    const load = toolOutput(turn.appended, 'load_content');
    expect(load.loaded).toBe(true);
    expect(load.url).toBe('https://qiita.com/alice/items/abc');
    expect(String(load.body)).toContain('Queueで重い処理を分離する。');

    const save = toolOutput(turn.appended, 'save_loaded');
    expect(save.saved).toBe(true);
    expect(save.github_url).toBe('https://github.com/example/clips/blob/main/clip.md');
    expect(save.body).toBeUndefined();

    // ロードと保存で二重に取らない。保存はロード済みの本文をそのまま書く。
    expect(recorded.articleFetches).toBe(1);

    expect(turn.reply).toContain('要するに重い処理はQueueへ分けなさい');

    // 返信へ付ける「片付ける」ボタンの材料。文面ではなくツールの実行結果から取る（ADR 0015）。
    expect(turn.saved).toEqual([{ path: 'clips/Worker設計.md', title: 'Worker設計' }]);

    // 保存できたクリップは台帳にも入る。入らないと週次ダイジェストに永久に出てこない（ADR 0010）。
    expect(
      await testEnv.CLIPS.prepare('SELECT path, url FROM clips').first(),
    ).toEqual({
      path: 'clips/Worker設計.md',
      url: 'https://qiita.com/alice/items/abc',
    });

    // user / assistant(load) / tool / assistant(save) / tool / assistant(text)
    expect(turn.appended.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  /**
   * 順序を実際に止めているのはここだけ。名前と説明文は働きかけでしかない（ADR 0012）。
   * モデルが組み立てた実在しないURLも、読んでいない以上ここで止まる。
   */
  it('refuses to save a URL that was not loaded in this turn', async () => {
    const recorded = mockWorld([
      saveCallReply('https://qiita.com/alice/items/abc'),
      modelResponse([{ text: '先に中身を読んでくるわね。' }]),
    ]);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://qiita.com/alice/items/abc',
      receivedAt: RECEIVED_AT,
    });

    expect(toolOutput(turn.appended, 'save_loaded')).toEqual({
      saved: false,
      not_loaded: 'https://qiita.com/alice/items/abc',
    });
    // 保存できていないので、返信にボタンは付かない（ADR 0015）。
    expect(turn.saved).toEqual([]);
    // 取得も保存も走らない。拒否だけして返す。
    expect(recorded.articleFetches).toBe(0);
    expect(recorded.savedPath).toBe('');
    expect(await testEnv.CLIPS.prepare('SELECT COUNT(*) AS n FROM clips').first()).toEqual({ n: 0 });
  });

  it('overwrites the file that is already there instead of failing', async () => {
    // 同じタイトルの記事は上書きする（ADR 0005 / 0013）。更新にはshaが要り、
    // これを載せ損ねるとGitHubが422で拒否する。
    const recorded = mockWorld(
      [
        loadCallReply('https://qiita.com/alice/items/abc'),
        saveCallReply('https://qiita.com/alice/items/abc'),
        modelResponse([{ text: '同じ場所へ置き直しておいたわ。' }]),
      ],
      (url, method) =>
        url.includes('/repos/example/clips/contents/') && method === 'GET'
          ? jsonResponse({
              sha: 'old-sha',
              html_url: 'https://github.com/example/clips/blob/main/clip.md',
            })
          : undefined,
    );

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://qiita.com/alice/items/abc',
      receivedAt: RECEIVED_AT,
    });

    expect(recorded.savedSha).toBe('old-sha');
    expect(recorded.savedPath).toBe('clips/Worker設計.md');
    expect(toolOutput(turn.appended, 'save_loaded')).toMatchObject({ saved: true });
    // 台帳も1行のまま。保存し直しは新しいクリップではない。
    expect(
      await testEnv.CLIPS.prepare('SELECT COUNT(*) AS n FROM clips').first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  /**
   * スマホのGoogleアプリから共有すると`share.google/{id}`が届く。実体は記事本体で、
   * リダイレクトの着いた先で種類を判定するのでZenn専用の取り方が選ばれる（ADR 0012）。
   */
  it('saves the article the redirects landed on, not the URL that was sent', async () => {
    const article = 'https://zenn.dev/alice/articles/abc123def456';
    const recorded = mockWorld(
      [
        loadCallReply('https://share.google/tQD'),
        // AIはロードが返した着いた先のURLを渡す。
        saveCallReply(article),
        modelResponse([{ text: 'Zennの記事だったわよ。' }]),
      ],
      (url) => {
        if (url === 'https://share.google/tQD') return htmlResponse('', 200, article);
        if (url.startsWith('https://zenn.dev/api/articles/')) {
          return jsonResponse({ article: { title: 'Zennの記事', body_html: '<p>本文</p>' } });
        }
        return undefined;
      },
    );

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'https://share.google/tQD',
      receivedAt: RECEIVED_AT,
    });

    // 中継URLだったことはAIにも伝わる。
    expect(toolOutput(turn.appended, 'load_content')).toMatchObject({
      url: article,
      requested_url: 'https://share.google/tQD',
      source: 'zenn',
    });
    expect(recorded.savedPath).toBe('clips/Zennの記事.md');
    // 台帳の`url`は中継URLではなく着いた先になる。
    expect(await testEnv.CLIPS.prepare('SELECT url FROM clips').first()).toEqual({ url: article });
  });

  it('keeps the thought signature in history and sends it back on the next turn', async () => {
    mockWorld([
      loadCallReply('https://qiita.com/alice/items/abc'),
      saveCallReply('https://qiita.com/alice/items/abc'),
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
            toolName: 'load_content',
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
            toolName: 'load_content',
            output: { type: 'json', value: { loaded: true, title: 'Worker設計', body: ARTICLE } },
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
    // 保存の無いターンにボタンは付かない（ADR 0015）。
    expect(turn.saved).toEqual([]);
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

  it('sends google_search and the clipping tools together with VALIDATED tool config', async () => {
    // Gemini 3世代でしか併用は成立しない。AI_MODELを2.x系へ落とすと保存のツールが黙って消えるため、
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
    expect(functionTools?.functionDeclarations.map((declaration) => declaration.name)).toEqual(
      expect.arrayContaining(['load_content', 'save_loaded']),
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

  /** AI SDKの内部再試行は2秒→4秒。使い切るまで待つため、この1件だけ延ばす。 */
  const RETRY_TIMEOUT_MS = 20_000;

  it('classifies a quota failure as chat even after the SDK exhausts its own retries', async () => {
    // 429は再試行対象なのでAI SDKが2回やり直し、3回目でAPICallErrorではなくRetryErrorを投げる。
    // 包みを剥がさないとstageがvalidationに化け、429と500の区別も消える（ADR 0008）。
    let modelCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!String(input).includes(':generateContent')) {
        throw new Error(`unexpected request: ${String(input)}`);
      }
      modelCalls += 1;
      return jsonResponse(
        { error: { code: 429, message: 'You exceeded your current quota' } },
        429,
      );
    });

    const error = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: 'Honoの最新バージョンっていくつ？',
      receivedAt: RECEIVED_AT,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(modelCalls).toBe(3);
    expect(error).toBeInstanceOf(ClipError);
    const clipError = error as ClipError;
    expect(clipError.stage).toBe('chat');
    expect(clipError.status).toBe(429);
    expect(clipError.retryable).toBe(true);
    // ゲートウェイが返した理由はログに残す。
    expect(clipError.message).toContain('You exceeded your current quota');
  }, RETRY_TIMEOUT_MS);

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
          : loadCallReply('https://qiita.com/alice/items/gone');
      }
      // 記事ページも`.md`も404。リダイレクト解決は投げないので、本文の取得で落ちる。
      if (url.startsWith('https://qiita.com/alice/items/gone')) return jsonResponse({}, 404);
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

    expect(toolOutput(turn.appended, 'load_content')).toEqual({ loaded: false, failed_at: 'fetch' });
    expect(putCalled).toBe(false);
    expect(turn.reply).toContain('何も残していない');
  });
});

/**
 * 削除の経路（ADR 0016）。
 *
 * ここで確かめるのは、モデルの言い分ではなくツールが実際に何をしたかである。
 * GitHubへDELETEが飛んだか、台帳の行が消えたか、失敗したときに片方だけ消えていないか。
 */
describe('deleting a clip', () => {
  const CLIP_PATH = 'clips/中身の無い記事.md';

  /** GitHubにファイルが在る世界。GETがshaを返し、DELETEはmockWorldの既定が受ける。 */
  const fileExists = (url: string, method: string): Response | undefined =>
    url.includes('/repos/example/clips/contents/') && method === 'GET'
      ? jsonResponse({
          sha: 'old-sha',
          html_url: 'https://github.com/example/clips/blob/main/clip.md',
        })
      : undefined;

  async function seedClip(): Promise<void> {
    await recordClip(makeEnv(), {
      path: CLIP_PATH,
      url: 'https://example.com/broken',
      title: '中身の無い記事',
      excerpt: '概要しか無い',
      clippedAt: '2026-08-14T00:00:00.000Z',
    });
  }

  const countClips = async (): Promise<number> =>
    ((await testEnv.CLIPS.prepare('SELECT COUNT(*) AS n FROM clips').first<{ n: number }>())?.n ?? -1);

  it('searches first, then deletes the file and the ledger row', async () => {
    await seedClip();
    const recorded = mockWorld(
      [findCallReply('中身の無い'), deleteCallReply(1), modelResponse([{ text: '消しておいたわ。' }])],
      fileExists,
    );

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: '中身の無い記事、消して',
      receivedAt: RECEIVED_AT,
    });

    // 検索が返すのは、モデルが組み立てられないターン内限定の番号である。
    expect(toolOutput(turn.appended, 'find_clips')).toEqual({
      found: [
        {
          ref: 1,
          title: '中身の無い記事',
          url: 'https://example.com/broken',
          path: CLIP_PATH,
          clipped_at: '2026-08-14T00:00:00.000Z',
          dismissed: false,
        },
      ],
    });
    expect(toolOutput(turn.appended, 'delete_clip')).toEqual({
      deleted: true,
      title: '中身の無い記事',
      github: 'deleted',
    });
    // 引いたshaをそのまま返す。取り違えるとGitHubが409で拒否する。
    expect(recorded.deletedPath).toBe(CLIP_PATH);
    expect(recorded.deletedSha).toBe('old-sha');
    expect(await countClips()).toBe(0);
  });

  it('refuses a ref it never handed out, without touching GitHub or the ledger', async () => {
    await seedClip();
    // 探さずにいきなり消そうとする。説明文ではなくターン内の対応表がこれを止める。
    const recorded = mockWorld([deleteCallReply(7), modelResponse([{ text: 'まず探すわね。' }])], fileExists);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: '中身の無い記事、消して',
      receivedAt: RECEIVED_AT,
    });

    expect(toolOutput(turn.appended, 'delete_clip')).toEqual({ deleted: false, unknown_ref: 7 });
    expect(recorded.deletedPath).toBe('');
    expect(await countClips()).toBe(1);
  });

  it('still clears the ledger row when the file is already gone from GitHub', async () => {
    await seedClip();
    // mockWorldの既定のGETは404。保存に失敗していたクリップの行がこれにあたる。
    const recorded = mockWorld([
      findCallReply('中身の無い'),
      deleteCallReply(1),
      modelResponse([{ text: 'ファイルはもう無かったわ。記録は消しておいた。' }]),
    ]);

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: '中身の無い記事、消して',
      receivedAt: RECEIVED_AT,
    });

    expect(toolOutput(turn.appended, 'delete_clip')).toMatchObject({
      deleted: true,
      github: 'missing',
    });
    expect(recorded.deletedPath).toBe('');
    expect(await countClips()).toBe(0);
  });

  it('keeps the ledger row when GitHub refuses the delete', async () => {
    await seedClip();
    // 片方だけ消えるのが最も悪い。ファイルが残っているなら行も残す。
    mockWorld(
      [
        findCallReply('中身の無い'),
        deleteCallReply(1),
        modelResponse([{ text: '消せなかったわ。時間を置いて言ってちょうだい。' }]),
      ],
      (url, method) => {
        if (!url.includes('/repos/example/clips/contents/')) return undefined;
        if (method === 'GET') return fileExists(url, method);
        return method === 'DELETE' ? jsonResponse({ message: 'boom' }, 500) : undefined;
      },
    );

    const turn = await runChatTurn({
      env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      history: [],
      userText: '中身の無い記事、消して',
      receivedAt: RECEIVED_AT,
    });

    expect(toolOutput(turn.appended, 'delete_clip')).toEqual({ deleted: false, failed_at: 'github' });
    expect(await countClips()).toBe(1);
  });
});
