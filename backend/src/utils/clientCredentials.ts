import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const BCRYPT_PREFIX = /^\$2[aby]\$/;

export function generateClientId(prefix = 'tenant'): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return `client_${safePrefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function hashClientSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, 12);
}

export async function verifyClientSecret(
  storedValue: string,
  informedSecret: string
): Promise<{ valid: boolean; legacyPlaintext: boolean }> {
  if (!storedValue || !informedSecret) {
    return { valid: false, legacyPlaintext: false };
  }

  if (BCRYPT_PREFIX.test(storedValue)) {
    return {
      valid: await bcrypt.compare(informedSecret, storedValue),
      legacyPlaintext: false
    };
  }

  const left = Buffer.from(storedValue);
  const right = Buffer.from(informedSecret);
  const valid = left.length === right.length && crypto.timingSafeEqual(left, right);
  return { valid, legacyPlaintext: valid };
}

export async function createClientCredentials(prefix = 'tenant'): Promise<{
  client_id: string;
  client_secret: string;
  client_secret_hash: string;
}> {
  const client_secret = generateClientSecret();
  return {
    client_id: generateClientId(prefix),
    client_secret,
    client_secret_hash: await hashClientSecret(client_secret)
  };
}
