import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ToolState } from '../src/tool-state';
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
  it('issues opaque owner-bound refs and preserves the loaded snapshot', async () => {
    const alice = state('tool-state-alice');
    const ref = await alice.putLoaded(content, '2026-08-24T00:00:00.000Z');

    expect(ref).not.toContain('example.com');
    expect(ref).not.toContain('秘密');
    expect(await alice.resolveLoaded(ref, '2026-08-25T00:00:00.000Z')).toEqual({
      ok: true,
      payload: content,
    });
    expect(await state('tool-state-bob').resolveLoaded(ref)).toEqual({
      ok: false,
      error: 'unknown_ref',
    });
  });

  it('rejects the wrong kind and expired refs', async () => {
    const stub = state('tool-state-kind-expiry');
    const ref = await stub.putLoaded(content, '2026-08-24T00:00:00.000Z');

    expect(await stub.resolveClip(ref, '2026-08-25T00:00:00.000Z')).toEqual({
      ok: false,
      error: 'wrong_kind',
    });
    expect(await stub.resolveLoaded(ref, '2026-12-01T00:00:00.000Z')).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('deletes expired refs from the alarm', async () => {
    const stub = state('tool-state-alarm');
    const ref = await stub.putLoaded(content);
    await runInDurableObject(stub, async (_instance, objectState) => {
      objectState.storage.sql.exec(
        "UPDATE tool_refs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE ref = ?",
        ref,
      );
    });

    await runInDurableObject(stub, (instance) => (instance as ToolState).alarm());
    expect(await stub.resolveLoaded(ref)).toEqual({ ok: false, error: 'unknown_ref' });
  });

  it('issues one ref per candidate in a single call, each resolvable on its own', async () => {
    // 検索も一覧も複数の候補を返すので、単発の口を残さない（ADR 0031）。
    const stub = state('tool-state-put-clips');
    const payloads = [
      { path: 'clips/一件目.md', title: '一件目' },
      { path: 'clips/二件目.md', title: '二件目' },
    ];

    const refs = await stub.putClips(payloads);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    expect(await stub.resolveClip(refs[0]!)).toEqual({ ok: true, payload: payloads[0] });
    expect(await stub.resolveClip(refs[1]!)).toEqual({ ok: true, payload: payloads[1] });
    expect(await stub.putClips([])).toEqual([]);
  });

  it('reschedules the alarm to the next remaining expiry', async () => {
    const stub = state('tool-state-alarm-reschedule');
    await stub.putLoaded(content, '2026-08-24T00:00:00.000Z');
    await stub.putClips(
      [{ path: 'clips/later.md', title: 'later' }],
      '2026-08-25T00:00:00.000Z',
    );

    await runInDurableObject(stub, async (instance, objectState) => {
      objectState.storage.sql.exec(
        "UPDATE tool_refs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'loaded'",
      );
      await (instance as ToolState).alarm();
      expect(await objectState.storage.getAlarm()).toBe(
        Date.parse('2026-11-23T00:00:00.000Z'),
      );
    });
  });
});
