import {
  createClientCredentials,
  generateClientSecret,
  hashClientSecret,
  verifyClientSecret
} from './clientCredentials';

describe('clientCredentials', () => {
  it('gera segredo forte e persiste somente hash bcrypt', async () => {
    const credentials = await createClientCredentials('prod_tms');

    expect(credentials.client_id).toMatch(/^client_prod_tms_[a-f0-9]{16}$/);
    expect(credentials.client_secret.length).toBeGreaterThanOrEqual(40);
    expect(credentials.client_secret_hash).toMatch(/^\$2[aby]\$/);
    expect(credentials.client_secret_hash).not.toContain(credentials.client_secret);

    await expect(
      verifyClientSecret(credentials.client_secret_hash, credentials.client_secret)
    ).resolves.toEqual({ valid: true, legacyPlaintext: false });
  });

  it('mantém compatibilidade com segredo legado e sinaliza migração', async () => {
    await expect(verifyClientSecret('secret_123', 'secret_123')).resolves.toEqual({
      valid: true,
      legacyPlaintext: true
    });
    await expect(verifyClientSecret('secret_123', 'errado')).resolves.toEqual({
      valid: false,
      legacyPlaintext: false
    });
  });

  it('não aceita segredo diferente contra bcrypt', async () => {
    const secret = generateClientSecret();
    const hash = await hashClientSecret(secret);

    await expect(verifyClientSecret(hash, 'outro-segredo')).resolves.toEqual({
      valid: false,
      legacyPlaintext: false
    });
  });
});
