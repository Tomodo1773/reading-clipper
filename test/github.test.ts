import { describe, expect, it } from 'vitest';
import { createGitHubAppJwt } from '../src/github';
import { generateGitHubAppKeyPair } from './helpers';

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
