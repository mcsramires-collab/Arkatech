/**
 * Segredo usado para assinar/verificar os JWTs emitidos em POST /api/v1/auth/token.
 *
 * Antes, `authMiddleware.ts` e `auth.ts` duplicavam
 * `process.env.JWT_SECRET || 'dev_secret_key_arckatech_super_secure_2026'` — ou seja,
 * se a variável de ambiente JWT_SECRET não estivesse configurada em produção (erro de
 * deploy, `.env` não carregado, etc.), a API assinava e validava tokens silenciosamente
 * com uma chave fixa e pública (presente neste repositório open). Qualquer pessoa com
 * acesso ao código conseguiria forjar um token válido para qualquer tenant.
 *
 * Agora a ausência de JWT_SECRET falha alto e explicitamente (o processo não sobe /
 * a rota não funciona) em vez de degradar silenciosamente para uma chave insegura.
 * Ambientes de dev/CI que precisam de um valor continuam podendo defini-lo
 * explicitamente (ex.: docker-compose.yml já define JWT_SECRET para o serviço backend).
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET não está configurado. Defina a variável de ambiente JWT_SECRET antes de emitir ou validar tokens.'
    );
  }
  return secret;
}
