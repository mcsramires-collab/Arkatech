# Contrato de suspensão de apólice

`POST /api/v1/admin/policies/:id/suspensao` recebe `desde` obrigatório e `ate` opcional.
Autenticação de backoffice/chave interna, permissão `apolices: editar` e escopo da
seguradora continuam sendo aplicados antes da validação do corpo.

## Formatos aceitos

- Data de calendário válida: `YYYY-MM-DD`, por exemplo `2028-02-29`.
- Instante ISO com segundos e fuso explícito: `YYYY-MM-DDTHH:mm:ssZ` ou
  `YYYY-MM-DDTHH:mm:ss±HH:mm`, com fração opcional de 1 a 3 dígitos.
  Exemplos: `2026-10-07T15:00:00.000Z` e `2026-10-07T12:00:00-03:00`.
- `ate` omitido, `null` ou string vazia mantém a compatibilidade de prazo
  indeterminado e remove um término anterior. Outros tipos são inválidos.

Datas impossíveis, formatos locais/ambíguos, timestamps sem fuso, valores não
textuais e término anterior ao início retornam HTTP 400, sem alterar a apólice
nem chamar a persistência. Os limites são comparados como instantes, considerando
os offsets; igualdade é permitida. Valores aceitos são preservados na resposta
`{ status: "sucesso", policy }` e no armazenamento, sem reformatar o texto.

## Semântica temporal preservada

A suspensão usa limites inclusivos: `agora >= desde && (sem ate || agora <= ate)`.
Em ambos os limites, `YYYY-MM-DD` representa **00:00:00.000 UTC** daquele dia,
preservando a interpretação existente de `new Date(...)` no motor de averbação,
no status cadastral e no ciclo de vida do segurado. Um término date-only **não**
significa o final do dia civil e não usa `POLICY_BUSINESS_TIMEZONE`.

Para suspender até o final do dia selecionado no portal, o cliente deve resolver
explicitamente seu fuso e enviar o instante correspondente, por exemplo
`2026-10-07T23:59:59.999-03:00`. O portal em integração envia início via
`toISOString()` e converte o fim do dia no fuso local do navegador para ISO UTC;
prazo indeterminado omite `ate`.

`DELETE /api/v1/admin/policies/:id/suspensao` continua limpando os dois campos para
reativação. Este ajuste não altera o motor, dados antigos, schema ou migrações.

## Validação

`src/integration/policySuspensionContracts.test.ts` exercita o aplicativo HTTP real:
datas/timestamps válidos, anos bissextos, offsets e igualdade, prazo indeterminado,
tipos/datas inválidos, ordem temporal, ausência de mutação/persistência em erros,
autenticação, RBAC, isolamento entre seguradoras, administração e reativação.
Os testes usam `runTestLabEphemeral()` e credenciais sintéticas locais.
