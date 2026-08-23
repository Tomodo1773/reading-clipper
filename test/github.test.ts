import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitHubAppJwt, resetGitHubTokenCache, searchGitHubCode } from '../src/github';
import { generateGitHubAppKeyPair, jsonResponse, makeEnv } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  resetGitHubTokenCache();
});

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

describe('GitHub App JWT', () => {
  it('signs a JWT with a PKCS#8 PEM private key', async () => {
    const { privateKeyPem, publicKey } = await generateGitHubAppKeyPair();
    const jwt = await createGitHubAppJwt('12345', privateKeyPem, 1_700_000_000);
    const [header, payload, signature] = jwt.split('.');

    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(header!)))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload!)))).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_540,
      iss: '12345',
    });
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        base64UrlToBytes(signature!),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
  });

  it('rejects the legacy PKCS#1 PEM format', async () => {
    await expect(
      createGitHubAppJwt('12345', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    ).rejects.toMatchObject({ message: 'GitHub App private key must be a PKCS#8 PEM' });
  });
});

describe('GitHub Code Search', () => {
  it('uses an installation token and keeps only clips from the configured repository', async () => {
    const { privateKeyPem } = await generateGitHubAppKeyPair();
    let searched: URL | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }, 201);
      }
      if (url.pathname === '/search/code') {
        searched = url;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer installation-token');
        expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.github.text-match+json');
        return jsonResponse({
          total_count: 3,
          incomplete_results: false,
          items: [
            {
              path: 'clips/設計.md',
              sha: 'sha-1',
              html_url: 'https://github.com/example/clips/blob/main/clips/x.md',
              repository: { full_name: 'example/clips' },
              text_matches: [{ property: 'content', fragment: '前後 オントロジー 前後' }],
            },
            {
              path: 'clips/README.md',
              sha: 'sha-2',
              html_url: 'https://github.com/example/clips/blob/main/clips/README.md',
              repository: { full_name: 'example/clips' },
              text_matches: [{ property: 'path', fragment: 'clips/README.md' }],
            },
            {
              path: 'clips/other.md',
              sha: 'sha-3',
              html_url: 'https://github.com/other/repo/blob/main/clips/other.md',
              repository: { full_name: 'other/repo' },
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const matches = await searchGitHubCode(
      makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
      'オントロジー',
      16,
    );

    expect(searched?.searchParams.get('q')).toBe(
      'オントロジー in:file,path repo:example/clips path:clips/ extension:md',
    );
    expect(searched?.searchParams.get('per_page')).toBe('16');
    expect(matches).toEqual([
      {
        path: 'clips/設計.md',
        sha: 'sha-1',
        htmlUrl: 'https://github.com/example/clips/blob/main/clips/x.md',
        matchedIn: 'body',
        snippet: '前後 オントロジー 前後',
      },
      {
        path: 'clips/README.md',
        sha: 'sha-2',
        htmlUrl: 'https://github.com/example/clips/blob/main/clips/README.md',
        matchedIn: 'title',
        snippet: 'clips/README.md',
      },
    ]);
  });

  it('does not turn incomplete search results into a false not-found', async () => {
    const { privateKeyPem } = await generateGitHubAppKeyPair();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.pathname.includes('/app/installations/')
        ? jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }, 201)
        : jsonResponse({ total_count: 1, incomplete_results: true, items: [] });
    });

    await expect(
      searchGitHubCode(makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }), '設計', 8),
    ).rejects.toMatchObject({ message: 'GitHub code search returned incomplete results' });
  });
});
