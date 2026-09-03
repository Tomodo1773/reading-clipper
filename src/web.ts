import type { CoreWebEntrypoint } from './core-rpc';

/**
 * 閲覧ページの公開境界（ADR 0036）。
 *
 * 認証はhostnameへ掛けたCloudflare Access applicationのpolicyが正本で、ここでは本人を
 * 照合しない。このWorkerは静的アセットを持つため`ctx.access`が渡らず、照合しようにも
 * 身元を読めない。Accessを通らない別名の入口を作らないことが、そのまま唯一の錠になる
 * （`wrangler.web.jsonc`で`workers.dev`とpreview URLを無効にしている）。
 */
export interface WebEnv {
  CORE: Service<CoreWebEntrypoint>;
}

/** 自分がブラウザから開くクリップ一覧（ADR 0030、ADR 0032、ADR 0033）。 */
const CLIP_PAGE_PATH = '/clips';

/** 保存した本文を読むページ（ADR 0034）。 */
const CLIP_READ_PATH = '/clips/read';

/** 一覧の未片付けカードから、1件だけ片付ける入口（ADR 0033）。 */
const CLIP_DISMISS_PATH = '/clips/dismiss';

/**
 * 閲覧ページの防御をエスケープ1枚に頼らない（ADR 0030）。
 *
 * 抜粋は記事本文から作る外部由来の文字列で、エスケープを外すと注入になる。このページは
 * スクリプトを1行も持たず、外へ読みに行くのはサムネイルだけなので、`script-src`を落として
 * おけばエスケープが漏れても実行に繋がらない。CSSは`<style>`で埋めているため`style-src`
 * だけはinlineを許す。
 */
const CLIP_PAGE_CSP =
  "default-src 'none'; img-src https:; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'";

/** 閲覧の面は2枚とも同じ扱いで返す。 */
function pageResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Accessの後ろにある個人的な一覧なので、共有キャッシュにも履歴にも残さない。
      'cache-control': 'private, no-store',
      'content-security-policy': CLIP_PAGE_CSP,
    },
  });
}

/**
 * 未片付けカードのformを受ける（ADR 0033）。
 *
 * Accessのクッキーは既定でSameSite=Noneなので、他サイトへ置かれたformからのPOSTでも
 * Accessは通ってしまう。状態を変えるのはこの入口だけなので、ここでOriginを見て止める。
 * ブラウザはPOSTに必ずOriginを付けるため、無いものは通さない。
 */
async function dismissClip(request: Request, env: WebEnv, origin: string): Promise<Response> {
  if (request.headers.get('origin') !== origin) {
    return new Response('Forbidden', { status: 403 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const path = form.get('path');
  if (typeof path !== 'string' || !path.startsWith('clips/')) {
    return new Response('Bad request', { status: 400 });
  }

  const result = await env.CORE.dismissClip(path);
  if (result.updated) {
    return new Response(null, {
      status: 303,
      headers: { location: CLIP_PAGE_PATH, 'cache-control': 'private, no-store' },
    });
  }
  return new Response('Clip could not be dismissed', {
    status: 'unknown_path' in result ? 404 : 500,
  });
}

export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === CLIP_PAGE_PATH) {
      return pageResponse(await env.CORE.clipPage());
    }
    if (request.method === 'GET' && url.pathname === CLIP_READ_PATH) {
      const html = await env.CORE.clipReadPage(url.searchParams.get('path') ?? '');
      return html ? pageResponse(html) : new Response('Not found', { status: 404 });
    }
    if (request.method === 'POST' && url.pathname === CLIP_DISMISS_PATH) {
      return dismissClip(request, env, url.origin);
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WebEnv>;
