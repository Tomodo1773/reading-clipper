import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshClipIndex } from '../src/clip-index';
import {
  CLIP_INDEX_MARKER,
  isGeneratedClipIndex,
  renderClipIndex,
} from '../src/clip-index-format';
import type { ClipRow } from '../src/clips';
import { recordClip } from '../src/clips';
import { resetGitHubTokenCache } from '../src/github';
import { base64ToUtf8, utf8ToBase64 } from '../src/utils';
import {
  generatePrivateKeyPem,
  jsonResponse,
  makeEnv,
  resetClips,
} from './helpers';

const clip = (overrides: Partial<ClipRow> = {}): ClipRow => ({
  path: 'clips/Worker 設計.md',
  url: 'https://zenn.dev/alice/articles/worker',
  title: 'Worker [設計]',
  clippedAt: '2026-08-18T15:30:00.000Z',
  ...overrides,
});

beforeEach(async () => {
  vi.restoreAllMocks();
  resetGitHubTokenCache();
  await resetClips();
});

describe('renderClipIndex', () => {
  it('renders a JST date, escaped title, source link, and host', () => {
    expect(renderClipIndex([{ ...clip(), title: 'Worker [設計]' }])).toBe(
      `${CLIP_INDEX_MARKER}\n` +
        '# Clips\n\n' +
        '最近追加した20件を、新しい順に表示している。\n\n' +
        '- 8/19 · [Worker \\[設計\\]](<https://zenn.dev/alice/articles/worker>) · zenn.dev\n',
    );
  });

  it('renders old entries with invalid optional metadata as plain titles', () => {
    const rendered = renderClipIndex([
      {
        path: 'clips/qiita.com/記事 (1).md',
        url: 'not a URL',
        title: '記事 (1)',
        clippedAt: 'invalid',
      },
    ]);

    expect(rendered).toContain('- 記事 (1)');
    expect(rendered).not.toContain('not a URL');
  });

  it('renders an explicit empty state', () => {
    expect(renderClipIndex([])).toContain('まだクリップはない。');
  });
});

describe('isGeneratedClipIndex', () => {
  it('excludes only the marked clips/README.md from backfill', () => {
    expect(isGeneratedClipIndex('clips/README.md', `${CLIP_INDEX_MARKER}\n# Clips`)).toBe(true);
    expect(isGeneratedClipIndex('clips/README.md', '# 手書きREADME')).toBe(false);
    expect(isGeneratedClipIndex('clips/archive/README.md', CLIP_INDEX_MARKER)).toBe(false);
  });
});

describe('refreshClipIndex', () => {
  async function envWithKey() {
    return makeEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
  }

  async function seedClip(): Promise<void> {
    await recordClip(makeEnv(), {
      path: 'clips/Worker設計.md',
      url: 'https://zenn.dev/alice/articles/worker',
      title: 'Worker設計',
      excerpt: 'Queueで分ける。',
      clippedAt: '2026-08-18T15:30:00.000Z',
    });
  }

  it('creates the generated README from D1', async () => {
    await seedClip();
    let written = '';
    let message = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { content: string; message: string };
        written = base64ToUtf8(body.content);
        message = body.message;
        return jsonResponse(
          { content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/clips/README.md' } },
          201,
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await refreshClipIndex(await envWithKey());

    expect(written).toContain(CLIP_INDEX_MARKER);
    expect(written).toContain(
      '[Worker設計](<https://zenn.dev/alice/articles/worker>)',
    );
    expect(message).toBe('Add clip index');
  });

  it('does not overwrite an unmanaged README', async () => {
    let putCalled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (method === 'GET') {
        return jsonResponse({
          sha: 'manual-sha',
          html_url: 'https://github.com/example/clips/blob/main/clips/README.md',
          encoding: 'base64',
          content: utf8ToBase64('# 手書きREADME'),
        });
      }
      putCalled = true;
      return jsonResponse({});
    });

    await expect(refreshClipIndex(await envWithKey())).rejects.toThrow('not managed');
    expect(putCalled).toBe(false);
  });

  it('refetches the SHA and retries once after a 409', async () => {
    let gets = 0;
    let puts = 0;
    const usedShas: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (method === 'GET') {
        gets += 1;
        return jsonResponse({
          sha: `sha-${gets}`,
          html_url: 'https://github.com/example/clips/blob/main/clips/README.md',
          encoding: 'base64',
          content: utf8ToBase64(`${CLIP_INDEX_MARKER}\n# Clips\n`),
        });
      }
      puts += 1;
      usedShas.push((JSON.parse(String(init?.body)) as { sha: string }).sha);
      return puts === 1
        ? jsonResponse({ message: 'conflict' }, 409)
        : jsonResponse({ content: { sha: 'done', html_url: 'https://example.com/index' } });
    });

    await refreshClipIndex(await envWithKey());

    expect(gets).toBe(2);
    expect(puts).toBe(2);
    expect(usedShas).toEqual(['sha-1', 'sha-2']);
  });
});
