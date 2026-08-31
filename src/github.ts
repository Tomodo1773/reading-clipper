import { ClipError, isRetryableStatus } from './errors';
import type { Env } from './types';
import {
  asRecord,
  assertOk,
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64Url,
  fetchWithTimeout,
  stringField,
  stringToBase64Url,
  utf8ToBase64,
} from './utils';

const GITHUB_API_VERSION = '2022-11-28';
const CODE_SEARCH_SIZE = 5;
/** `{ref}:{path}`でサブツリーを名指す。パス側は`clips/`固定なのでエスケープは要らない。 */
const CLIPS_TREE_REF = 'HEAD:clips';

/**
 * `clips/`直下のREADME。クリップの母集団から常に外す（ADR 0032）。
 *
 * かつては生成物だったので所有マーカーを見て判定していたが、生成をやめた今そこにあるのは
 * 手書きのREADMEだけである。`makeClipFileName`が題名`README`を`README-clip.md`へ
 * 逃がすので（`src/url.ts`）、このパスが記事であることはない。
 *
 * バックフィルは同じ判断をNode側で持つ。あちらは素のESMで走り、拡張子の無い相対importを
 * 解決できないため、このモジュールからは読めない。
 */
export const CLIPS_README_PATH = 'clips/README.md';

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

export interface GitHubTextFile extends GitHubFile {
  content: string;
}

/** GitHub Code Searchが返した、保存済みクリップの候補（ADR 0020）。 */
export interface GitHubCodeMatch extends GitHubFile {
  /** GitHubが返した一致箇所。記事の内容を答える根拠には使わない。 */
  snippet?: string;
}

export interface PutGitHubFileOptions {
  sha?: string;
  message?: string;
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

/**
 * 保存先リポジトリの`clips/`だけをGitHub Code Searchで探す（ADR 0020）。
 *
 * 検索語はGitHubの構文として渡るが、結果を保存先repoと`clips/*.md`へもう一度絞る。
 * モデルが`repo:`などを混ぜても、別リポジトリの結果はツールの外へ出ない。
 */
export async function searchGitHubCode(env: Env, query: string): Promise<GitHubCodeMatch[]> {
  const term = query.trim();
  if (!term) return [];
  const token = await getInstallationToken(env);
  const endpoint = new URL('https://api.github.com/search/code');
  endpoint.searchParams.set(
    'q',
    `${term} in:file,path repo:${env.GITHUB_REPO} path:clips/ extension:md`,
  );
  // 候補を見比べるには5件で足りる。続きが要るときは語を絞って探し直す（ADR 0020）。
  endpoint.searchParams.set('per_page', String(CODE_SEARCH_SIZE));
  const response = await fetchWithTimeout(
    endpoint,
    {
      headers: {
        ...githubHeaders(token),
        accept: 'application/vnd.github.text-match+json',
      },
    },
    20_000,
    'github',
  );
  assertOk(response, 'github');
  const payload = asRecord(await response.json());
  if (!payload || !Array.isArray(payload.items)) {
    throw new ClipError('GitHub code search response was invalid', 'github', true);
  }
  if (payload.incomplete_results === true) {
    throw new ClipError('GitHub code search returned incomplete results', 'github', true);
  }

  const expectedRepo = env.GITHUB_REPO.toLowerCase();
  const matches: GitHubCodeMatch[] = [];
  for (const value of payload.items) {
    const item = asRecord(value);
    const repository = asRecord(item?.repository);
    const path = stringField(item, 'path');
    const sha = stringField(item, 'sha');
    const htmlUrl = stringField(item, 'html_url');
    if (
      stringField(repository, 'full_name')?.toLowerCase() !== expectedRepo ||
      !path?.startsWith('clips/') ||
      !path.toLowerCase().endsWith('.md') ||
      path === CLIPS_README_PATH ||
      !sha ||
      !htmlUrl
    ) {
      continue;
    }

    const textMatches = Array.isArray(item?.text_matches) ? item.text_matches : [];
    const contentMatch = textMatches
      .map(asRecord)
      .find((match) => stringField(match, 'property') === 'content');
    const pathMatch = textMatches
      .map(asRecord)
      .find((match) => stringField(match, 'property') === 'path');
    matches.push({
      path,
      sha,
      htmlUrl,
      snippet: stringField(contentMatch ?? pathMatch, 'fragment'),
    });
    if (matches.length === CODE_SEARCH_SIZE) break;
  }
  return matches;
}

/**
 * `clips/`直下の保存済みクリップを、二次索引を経由せず一次データから数え上げる（ADR 0031）。
 *
 * サブツリーを直接引くのは、ルートの再帰取得だと`clips/`と無関係なディレクトリの増加が
 * 毎回の取得量へ連動し、Contents APIだと1ディレクトリ1000件の上限に当たるためである。
 * 返るのは`clips/`を除いたファイル名なので、ここで保存先パスへ戻す。
 */
export async function listGitHubClipFiles(env: Env): Promise<string[]> {
  const token = await getInstallationToken(env);
  const [owner, name] = repoParts(env.GITHUB_REPO);
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${CLIPS_TREE_REF}`,
    { headers: githubHeaders(token) },
    20_000,
    'github',
  );
  assertOk(response, 'github');
  const payload = asRecord(await response.json());
  if (!payload || !Array.isArray(payload.tree)) {
    throw new ClipError('GitHub clip tree response was invalid', 'github', true);
  }
  // 全件を見られていない以上、走査した結果として扱ってはならない（ADR 0031）。
  // Code Searchの`incomplete_results`と同じ規則である。
  if (payload.truncated === true) {
    throw new ClipError('GitHub clip tree was truncated', 'github', true);
  }

  const paths: string[] = [];
  for (const value of payload.tree) {
    const entry = asRecord(value);
    const fileName = stringField(entry, 'path');
    if (stringField(entry, 'type') !== 'blob' || !fileName) continue;
    if (!fileName.toLowerCase().endsWith('.md')) continue;
    const path = `clips/${fileName}`;
    if (path === CLIPS_README_PATH) continue;
    paths.push(path);
  }
  return paths;
}

async function getGitHubFilePayload(
  env: Env,
  path: string,
): Promise<Record<string, unknown> | undefined> {
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
  if (!payload) throw new ClipError('GitHub content response was invalid', 'github', true);
  return payload;
}

function githubFile(payload: Record<string, unknown>, path: string): GitHubFile {
  const sha = stringField(payload, 'sha');
  const htmlUrl = stringField(payload, 'html_url');
  if (!sha || !htmlUrl) {
    throw new ClipError('GitHub content response was invalid', 'github', true);
  }
  return { path, sha, htmlUrl };
}

/** shaとURLだけを読む。記事本文はデコードしない。 */
export async function getGitHubFile(env: Env, path: string): Promise<GitHubFile | undefined> {
  const payload = await getGitHubFilePayload(env, path);
  return payload ? githubFile(payload, path) : undefined;
}

/** 所有マーカーなど本文そのものを調べる用途だけで使う。 */
export async function getGitHubTextFile(
  env: Env,
  path: string,
): Promise<GitHubTextFile | undefined> {
  const payload = await getGitHubFilePayload(env, path);
  if (!payload) return undefined;
  const file = githubFile(payload, path);
  const encodedContent = stringField(payload, 'content');
  if (stringField(payload, 'encoding') !== 'base64' || !encodedContent) {
    throw new ClipError('GitHub text content response was invalid', 'github', true);
  }
  try {
    return { ...file, content: base64ToUtf8(encodedContent) };
  } catch (error) {
    throw new ClipError('GitHub text content could not be decoded', 'github', true, undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export async function putGitHubFile(
  env: Env,
  path: string,
  content: string,
  options: PutGitHubFileOptions = {},
): Promise<GitHubFile> {
  const { message, sha } = options;
  const token = await getInstallationToken(env);
  const response = await fetchWithTimeout(
    contentsUrl(env.GITHUB_REPO, path),
    {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: message ?? (sha ? `Update clip: ${path}` : `Add clip: ${path}`),
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
 * クリップのファイルを消す（ADR 0016）。戻り値は実際に消したかどうかで、既に無ければfalse。
 *
 * 消えるのはHEADからだけで、本文はこのコミットの1つ前に残る。削除を取り返す唯一の導線が
 * これなので、確認導線を設けない判断はここに依存している。
 *
 * shaの取得まで持つ。保存と違い削除の振る舞いは1通りしか無いので、
 * 「引いてから消す」を呼び出し側へ出しても分岐が増えるだけになる。
 */
export async function deleteGitHubFile(env: Env, path: string): Promise<boolean> {
  const existing = await getGitHubFile(env, path);
  if (!existing) return false;
  const token = await getInstallationToken(env);
  const response = await fetchWithTimeout(
    contentsUrl(env.GITHUB_REPO, path),
    {
      method: 'DELETE',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ message: `Delete clip: ${path}`, sha: existing.sha }),
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
  return true;
}

/** Testsでmodule-scope token cacheを分離するためのhook。 */
export function resetGitHubTokenCache(): void {
  cachedToken = undefined;
  tokenPromise = undefined;
}
