import { ClipError, isRetryableStatus } from './errors';
import type { Env } from './types';
import {
  asRecord,
  assertOk,
  base64ToBytes,
  bytesToBase64Url,
  fetchWithTimeout,
  stringField,
  stringToBase64Url,
  utf8ToBase64,
} from './utils';

const GITHUB_API_VERSION = '2022-11-28';

interface CachedToken {
  cacheKey: string;
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;
let tokenPromise: Promise<CachedToken> | undefined;

export interface GitHubFile {
  path: string;
  sha: string;
  htmlUrl: string;
}

function privateKeyDer(pemValue: string): Uint8Array {
  const pem = pemValue.replace(/\\n/g, '\n').trim();
  const begin = '-----BEGIN PRIVATE KEY-----';
  const end = '-----END PRIVATE KEY-----';
  if (!pem.startsWith(begin) || !pem.endsWith(end)) {
    throw new ClipError('GitHub App private key must be a PKCS#8 PEM', 'github', false);
  }
  const base64 = pem.slice(begin.length, -end.length).replace(/\s/g, '');
  if (!base64) throw new ClipError('GitHub App private key is invalid', 'github', false);
  try {
    return base64ToBytes(base64);
  } catch {
    throw new ClipError('GitHub App private key is invalid', 'github', false);
  }
}

export async function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = stringToBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = stringToBase64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const privateKey = privateKeyDer(privateKeyPem);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      privateKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    throw new ClipError('GitHub App private key could not be imported', 'github', false, undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

async function requestInstallationToken(env: Env): Promise<CachedToken> {
  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await fetchWithTimeout(
    `https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`,
    {
      method: 'POST',
      headers: githubHeaders(jwt),
    },
    20_000,
    'github',
  );
  assertOk(response, 'github');
  const payload = asRecord(await response.json());
  const token = stringField(payload, 'token');
  const expiresAt = stringField(payload, 'expires_at');
  if (!token || !expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new ClipError('GitHub installation token response was invalid', 'github', true);
  }
  return {
    cacheKey: `${env.GITHUB_APP_ID}:${env.GITHUB_INSTALLATION_ID}`,
    token,
    expiresAt: Date.parse(expiresAt),
  };
}

async function getInstallationToken(env: Env): Promise<string> {
  const cacheKey = `${env.GITHUB_APP_ID}:${env.GITHUB_INSTALLATION_ID}`;
  if (cachedToken?.cacheKey === cacheKey && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token;
  }
  if (!tokenPromise) tokenPromise = requestInstallationToken(env);
  try {
    cachedToken = await tokenPromise;
    return cachedToken.token;
  } finally {
    tokenPromise = undefined;
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'reading-clipper-worker',
    'x-github-api-version': GITHUB_API_VERSION,
  };
}

function repoParts(repo: string): [string, string] {
  const match = repo.match(/^([^/]+)\/([^/]+)$/);
  if (!match?.[1] || !match[2]) {
    throw new ClipError('GITHUB_REPO must use owner/repo format', 'github', false);
  }
  return [match[1], match[2]];
}

function contentsUrl(repo: string, path: string): string {
  const [owner, name] = repoParts(repo);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}`;
}

export async function getGitHubFile(env: Env, path: string): Promise<GitHubFile | undefined> {
  const token = await getInstallationToken(env);
  const response = await fetchWithTimeout(
    contentsUrl(env.GITHUB_REPO, path),
    { headers: githubHeaders(token) },
    20_000,
    'github',
  );
  if (response.status === 404) return undefined;
  assertOk(response, 'github');
  const payload = asRecord(await response.json());
  const sha = stringField(payload, 'sha');
  const htmlUrl = stringField(payload, 'html_url');
  if (!sha || !htmlUrl) {
    throw new ClipError('GitHub content response was invalid', 'github', true);
  }
  return { path, sha, htmlUrl };
}

export async function putGitHubFile(
  env: Env,
  path: string,
  content: string,
  sha?: string,
): Promise<GitHubFile> {
  const token = await getInstallationToken(env);
  const response = await fetchWithTimeout(
    contentsUrl(env.GITHUB_REPO, path),
    {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: sha ? `Update clip: ${path}` : `Add clip: ${path}`,
        content: utf8ToBase64(content),
        ...(sha ? { sha } : {}),
      }),
    },
    20_000,
    'github',
  );
  if (!response.ok) {
    throw new ClipError(
      `GitHub save returned ${response.status}`,
      'github',
      isRetryableStatus(response.status),
      response.status,
    );
  }
  const payload = asRecord(await response.json());
  const saved = asRecord(payload?.content);
  const savedSha = stringField(saved, 'sha');
  const htmlUrl = stringField(saved, 'html_url');
  if (!savedSha || !htmlUrl) throw new ClipError('GitHub save response was invalid', 'github', true);
  return { path, sha: savedSha, htmlUrl };
}

/**
 * クリップのファイルを消す（ADR 0016）。
 *
 * 消えるのはHEADからだけで、本文はこのコミットの1つ前に残る。削除を取り返す唯一の導線が
 * これなので、確認導線を設けない判断はここに依存している。
 *
 * `sha`は`getGitHubFile`で引いたものを渡す。古いshaを渡すと別のファイルが消えるのではなく、
 * 409で落ちる。
 */
export async function deleteGitHubFile(env: Env, path: string, sha: string): Promise<void> {
  const token = await getInstallationToken(env);
  const response = await fetchWithTimeout(
    contentsUrl(env.GITHUB_REPO, path),
    {
      method: 'DELETE',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ message: `Delete clip: ${path}`, sha }),
    },
    20_000,
    'github',
  );
  if (!response.ok) {
    throw new ClipError(
      `GitHub delete returned ${response.status}`,
      'github',
      isRetryableStatus(response.status),
      response.status,
    );
  }
}

/** Testsでmodule-scope token cacheを分離するためのhook。 */
export function resetGitHubTokenCache(): void {
  cachedToken = undefined;
  tokenPromise = undefined;
}
