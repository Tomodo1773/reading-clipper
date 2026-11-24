import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env, FetchedContent } from '../src/types';

const testEnv = env as unknown as Env;
const content: FetchedContent = {
  canonicalUrl: 'https://example.com/secret-path',
  source: 'web',
  title: '秘密の題名',
  markdown: '本文',
  complete: true,
};

function state(owner: string) {
  return testEnv.TOOL_STATE.get(testEnv.TOOL_STATE.idFromName(owner));
}

describe('ToolState', () => {
  it('issues opaque owner-bound refs and preserves the loaded body', async () => {
    const alice = state('tool-state-alice');
    const ref = await alice.putLoaded(content);

    expect(ref).not.toContain('example.com');
    expect(ref).not.toContain('秘密');
    expect(await alice.resolveLoaded(ref)).toEqual(content);
    expect(await state('tool-state-bob').resolveLoaded(ref)).toBeNull();
  });

  it('keeps one ref per URL and replaces the body when the URL is loaded again', async () => {
    const stub = state('tool-state-reload');
    const first = await stub.putLoaded(content);
    const reloaded = { ...content, markdown: '更新された本文' };

    expect(await stub.putLoaded(reloaded)).toBe(first);
    expect(await stub.resolveLoaded(first)).toEqual(reloaded);
    expect(await stub.putLoaded({ ...content, canonicalUrl: 'https://example.com/other' })).not.toBe(
      first,
    );
  });

  it('keeps one ref per clip path across searches', async () => {
    const stub = state('tool-state-clips');
    const payloads = [
      { path: 'clips/一件目.md', title: '一件目' },
      { path: 'clips/二件目.md', title: '二件目' },
    ];

    const refs = await stub.putClips(payloads);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    expect(await stub.resolveClip(refs[0]!)).toEqual(payloads[0]);
    expect(await stub.resolveClip(refs[1]!)).toEqual(payloads[1]);

    // 題名は最新の台帳に合わせるが、同じパスなら同じrefを返す。
    const renamed = { path: 'clips/一件目.md', title: '一件目（改題）' };
    expect(await stub.putClips([renamed])).toEqual([refs[0]]);
    expect(await stub.resolveClip(refs[0]!)).toEqual(renamed);
    expect(await stub.putClips([])).toEqual([]);
  });

  it('does not resolve a loaded ref as a clip ref, or the reverse', async () => {
    // 取得のrefで削除へ、検索のrefで保存へ届かせない（ADR 0016、ADR 0038）。
    const stub = state('tool-state-kinds');
    const loadedRef = await stub.putLoaded(content);
    const [clipRef] = await stub.putClips([{ path: 'clips/秘密の題名.md', title: '秘密の題名' }]);

    expect(await stub.resolveClip(loadedRef)).toBeNull();
    expect(await stub.resolveLoaded(clipRef!)).toBeNull();
  });
});
