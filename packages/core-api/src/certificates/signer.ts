import {
  canonicalJson,
  ed25519Sign,
  ed25519Verify,
  fromBase64,
  generateEd25519,
  importEd25519Pkcs8,
  sha256Hex,
  toBase64,
  toBase64Url,
  utf8,
  type Ed25519KeyPair,
} from '../lib/crypto.js';

export interface SignedPayload {
  /** SHA-256 (hex) of the canonical JSON payload. */
  payloadSha256: string;
  /** Ed25519 signature (base64url) over the canonical JSON bytes. */
  signature: string;
  keyId: string;
  algorithm: 'Ed25519';
}

/**
 * Signs certificate payloads with Ed25519. The public key is published at
 * `GET /v1/certificates/public-key`, so auditors can verify a certificate's
 * embedded JSON offline without trusting this service.
 */
export class CertificateSigner {
  private constructor(
    private readonly keys: Ed25519KeyPair,
    readonly keyId: string,
    readonly publicKeyRaw: Uint8Array,
    readonly ephemeral: boolean,
  ) {}

  static async fromPkcs8(pkcs8Base64: string): Promise<CertificateSigner> {
    return CertificateSigner.build(await importEd25519Pkcs8(pkcs8Base64), false);
  }

  /** Throwaway key for development — certificates stop verifying after a restart. */
  static async ephemeral(): Promise<CertificateSigner> {
    const { pair } = await generateEd25519();
    return CertificateSigner.build(pair, true);
  }

  private static async build(keys: Ed25519KeyPair, ephemeral: boolean): Promise<CertificateSigner> {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const keyId = (await sha256Hex(raw)).slice(0, 16);
    return new CertificateSigner(keys, keyId, raw, ephemeral);
  }

  async sign(payload: unknown): Promise<SignedPayload> {
    const bytes = utf8(canonicalJson(payload));
    const sig = await ed25519Sign(this.keys.privateKey, bytes);
    return { payloadSha256: await sha256Hex(bytes), signature: toBase64Url(sig), keyId: this.keyId, algorithm: 'Ed25519' };
  }

  async verify(payload: unknown, signature: string): Promise<boolean> {
    try {
      return await ed25519Verify(this.keys.publicKey, fromBase64(signature), utf8(canonicalJson(payload)));
    } catch {
      return false;
    }
  }

  publicJwk(): JsonWebKey & { kid: string; use: string; alg: string } {
    return { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(this.publicKeyRaw), kid: this.keyId, use: 'sig', alg: 'EdDSA' };
  }

  /** SubjectPublicKeyInfo PEM (12-byte Ed25519 SPKI prefix + raw key). */
  publicPem(): string {
    const spki = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...this.publicKeyRaw]);
    const b64 = toBase64(spki);
    return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
  }
}
