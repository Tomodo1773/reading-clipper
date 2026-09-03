import { describe, expect, it, vi } from 'vitest';
import web, { type WebEnv } from '../src/web';

const HOST = 'clips.example.com';

function webEnv() {
  const clipPage = vi.fn(async () => '<!doctype html>\n<html lang="ja"><body>Clips</body></html>');
  const clipReadPage = vi.fn(async (path: string) =>
    path === 'clips/a.md' ? '<html lang="ja"><body>保存した本文</body></html>' : undefined,
  );
  const dismissClip = vi.fn(async (path: string) =>
    path === 'clips/a.md'
      ? { updated: true as const, path, dismissed: true }
      : { updated: false as const, unknown_path: path },
  );
  return {
    env: { CORE: { clipPage, clipReadPage, dismissClip } as unknown as WebEnv['CORE'] },
    clipPage,
    clipReadPage,
    dismissClip,
  };
}

/** 閲覧ページはブラウザからのGETで、Originヘッダを持たない。 */
function pageRequest(path = '/clips'): Request {
  return new Request(`https://${HOST}${path}`, { headers: { host: HOST } });
}

function dismissRequest(path = 'clips/a.md', headers: HeadersInit = { origin: `https://${HOST}` }) {
  return new Request(`https://${HOST}/clips/dismiss`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: HOST, ...headers },
    body: new URLSearchParams({ path }),
  });
}

describe('clip page', () => {
  it('serves the page Core renders', async () => {
    const { env, clipPage } = webEnv();
    const response = await web.fetch(pageRequest(), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; img-src https:; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'",
    );
    expect(await response.text()).toContain('<html lang="ja">');
    expect(clipPage).toHaveBeenCalledOnce();
  });

  it('returns 404 for a path this boundary does not publish', async () => {
    const { env, clipPage } = webEnv();
    const response = await web.fetch(pageRequest('/clips/extra'), env);

    expect(response.status).toBe(404);
    expect(clipPage).not.toHaveBeenCalled();
  });
});

describe('clip read page', () => {
  it('serves the body Core renders for one clip', async () => {
    const { env, clipReadPage } = webEnv();
    const response = await web.fetch(pageRequest('/clips/read?path=clips%2Fa.md'), env);

    expect(response.status).toBe(200);
    // ヘッダは一覧と同じ1箇所で組む。中身はそちらのテストが見ている。
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('保存した本文');
    expect(clipReadPage).toHaveBeenCalledWith('clips/a.md');
  });

  it('returns 404 when Core has no such clip', async () => {
    const { env } = webEnv();
    const response = await web.fetch(pageRequest('/clips/read?path=clips%2F消した記事.md'), env);

    expect(response.status).toBe(404);
  });
});

describe('dismissing one clip', () => {
  it('dismisses the clip and returns to the page', async () => {
    const { env, dismissClip } = webEnv();
    const response = await web.fetch(dismissRequest(), env);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/clips');
    expect(dismissClip).toHaveBeenCalledWith('clips/a.md');
  });

  // Accessのクッキーは既定でSameSite=Noneなので、他サイトのformからのPOSTもAccessを通る。
  // 状態を変える入口を守っているのは、この判定だけである。
  it('does not accept a form posted from another site', async () => {
    const { env, dismissClip } = webEnv();
    const response = await web.fetch(
      dismissRequest('clips/a.md', { origin: 'https://attacker.example.com' }),
      env,
    );

    expect(response.status).toBe(403);
    expect(dismissClip).not.toHaveBeenCalled();
  });

  it('does not accept a state-changing form without an Origin', async () => {
    const { env, dismissClip } = webEnv();
    const response = await web.fetch(dismissRequest('clips/a.md', {}), env);

    expect(response.status).toBe(403);
    expect(dismissClip).not.toHaveBeenCalled();
  });

  it('refuses a path that points outside the clips directory, without asking Core', async () => {
    const { env, dismissClip } = webEnv();
    const response = await web.fetch(dismissRequest('.github/workflows/build.yml'), env);

    expect(response.status).toBe(400);
    expect(dismissClip).not.toHaveBeenCalled();
  });

  it('reports a clip the ledger does not have', async () => {
    const { env } = webEnv();
    const response = await web.fetch(dismissRequest('clips/消した記事.md'), env);

    expect(response.status).toBe(404);
  });
});
