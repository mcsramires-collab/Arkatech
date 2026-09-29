# Laboratório de Testes — P0/P1

O catálogo em `backend/src/services/testLabCatalog.ts` alimenta a UI, a seleção de suítes, os geradores e o relatório. O simulador de carga continua separado e preservado.

## Executar

Use Node 22, ambiente de desenvolvimento/teste e uma pasta de dados descartável:

```sh
cd backend
npm ci
npm run typecheck
npm run build
npm test -- --runInBand
npm run test:lab:p0
npm run test:lab:p1
cd ../frontend
npm ci
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

Defina `DATA_DIR` para uma pasta exclusiva de validação antes de iniciar o backend ou os comandos de teste. O Playwright inicia frontend/backend locais, usa credenciais fictícias e uma pasta de dados própria. Os relatórios JSON/CSV ficam em `test-results`; screenshots e traces permanecem locais, sem publicação de artefatos no GitHub.

## Implementação

- Fixtures XML de CT-e, NF-e, MDF-e e NFS-e com seed, data de referência, valor, número, protocolo, ambiente SEFAZ e papel do CNPJ explícitos (`TestLabFixtureGenerator`). MDF-e também é determinístico.
- Dataset sintético padrão no runner: segurado compartilhado, duas seguradoras, corretora e apólices identificadas; variantes incluem o mesmo ramo em duas seguradoras.
- BOOLEAN_BOTH, ENUM_ALL, NUMERIC_BOUNDARIES, DATE_BOUNDARIES, PAIRWISE e INVARIANT_MATRIX. Pairwise cobre todos os pares sem limitar silenciosamente o cartesiano; exaustivo rejeita matrizes acima do limite. Relógio por contexto permite testar igualdade exata nas fronteiras de vigência.
- Cenários chamam serviços reais de averbação, regras, ingestão e visibilidade. Cobrem suspensão, bypass, LMI, sublimites, coberturas, documentos, prazos, funções do CNPJ, matching, reprocessamento e deduplicação. Matrizes geradas complementam os cenários específicos de domínio.
- Portal, TMS, Connector/OUTBOUND, adapter WhatsApp e Mock SEFAZ. Testes HTTP exercitam contratos reais; testes do navegador exercitam planejamento/execução/histórico/exportação/presets/comparação contra backend local, além dos testes visuais com respostas controladas.
- Isolamento assíncrono de todas as coleções, incluindo usuários e permissões; nenhuma persistência ou espelhamento do contexto sintético. Execuções simultâneas e tráfego normal não compartilham os arrays do cenário. Reset ocorre ao descartar o contexto, inclusive após exceção.
- Bloqueio no próprio runner para produção e ambientes não reconhecidos, além de autenticação interna nas rotas. Testes verificam 401, 403 e bloqueio de produção via HTTP.
- Resultados por assertion com esperado/obtido, evidência, PASS/FAIL/GAP, histórico, reexecução somente de falhas, filtros, CSV e JSON detalhado, cobertura/gaps por regra e comparação entre execuções.
- Presets/suítes customizadas persistem neste navegador. Mudanças de catálogo são filtradas ao reaplicar a seleção. Comparação identifica adições/remoções, sem interpretar ausência como sucesso.
- Auditoria automática de `regras:*`, `recusas:*`, `rcv:*` nos fontes disponíveis e de todas as chaves persistidas. Para auditar também o repositório separado do Portal da Seguradora, disponibilize seu checkout e defina `TEST_LAB_UI_SOURCE` para a pasta de fontes. O CI deste repositório não tem, por si só, os fontes privados dos outros portais.

## PASS, FAIL e GAP

Uma configuração PLANNED nunca recebe PASS. Um executor ausente ou sem assertions é GAP. Regra não executada aparece como NOT_RUN/NÃO EXECUTADO na cobertura. Cobertura da execução indica cenários observados, não uma prova de todas as combinações possíveis.

A auditoria confirmou um GAP de produto em `policy.vigencia_inicio`: o motor não consulta a data inicial da vigência. O teste anterior de apólice ativa atribuía indevidamente cobertura a esse campo. A flag agora é PLANNED e há um GAP explícito na suíte P0. O gate mantém uma exceção nominal somente para esse gap conhecido; qualquer FAIL ou outro GAP P0 falha o CI. Isso não transforma o GAP em PASS nem declara a regra pronta para produção.

P1 mantém 41 gaps planejados do catálogo, incluindo regras locais do Portal, RC-V/faturamento e configurações sem efeito no motor. Eles constam nos relatórios; falhas e gaps de regras ativas bloqueiam o gate. Implementar o comportamento dessas configurações é trabalho de produto distinto da construção do laboratório, e o laboratório não o simula como aprovado.

SEFAZ real, WhatsApp Cloud API e conectores externos continuam dependentes de infraestrutura/credenciais externas. Os testes deste pacote usam os contratos e mocks locais e não comprovam disponibilidade desses serviços externos.

## Adicionar uma regra

1. Cadastre a flag com origem, estado real do motor, estratégia, valores e suíte no catálogo.
2. Acrescente executor com assertions de domínio no runner (ou amplie a família gerada correspondente). As famílias geradas obtêm seus valores do catálogo; a UI não exige componente novo.
3. Execute a auditoria, as suítes e os gates. Sem executor, o resultado permanece GAP. Regras apenas visuais devem permanecer PLANNED até terem comportamento verificável.
4. Preserve o contrato dos IDs de cenários para histórico/reexecução/comparação.
