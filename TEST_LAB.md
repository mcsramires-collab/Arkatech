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

## Laboratório V2

A interface interna agora separa dois usos que antes apareciam misturados:

- **Regressão Oficial**: suítes versionadas P0/P1, executores controlados pelo código e gate de CI. Continua sendo a fonte de verdade para regressão e invariantes.
- **Studio de Cenários**: exploração parametrizada pelo catálogo. O usuário escolhe dimensões, valores e expectativas; o backend cria um contexto sintético isolado, gera o DF-e e executa o pipeline real de ingestão + averbação.

A navegação V2 possui:

1. **Visão Geral** — saúde do catálogo, última regressão, gate P0 e mapa por domínio.
2. **Studio de Cenários** — Scenario Builder, Fixture Builder, Matrix Builder e Execution Center.
3. **Cobertura** — regra x execução com PASS, FAIL, GAP e NÃO EXECUTADO.
4. **Execuções** — histórico das regressões oficiais persistidas.
5. **Regressão Oficial** — preserva seleção de suítes, planejamento, execução, histórico, exportações, presets e comparação já existentes.

### Studio de Cenários

O Studio consome os metadados do catálogo. Regras realmente parametrizáveis recebem controles conforme `value_type`, `options`, `suggested_values` e `generation`. Regras PLANNED e invariantes/fluxos que não podem ser representados por um simples valor aparecem como **Regressão Oficial somente** em vez de receber um controle que não teria efeito real.

O payload do Studio aceita:

- estratégia `SINGLE`, `PAIRWISE` ou `CARTESIAN`;
- múltiplos valores por dimensão;
- apólice primária e, opcionalmente, uma segunda apólice de outra seguradora;
- matching automático ou `policy_id` explícito;
- ramo, OBS do documento e variáveis suplementares;
- resultado esperado por status, código e apólice selecionada.

`document.data_emissao` é uma dimensão P0 explícita, permitindo cruzar diretamente emissão do DF-e com `policy.vigencia_inicio`, `policy.vigencia_fim`, LMI, documento, canal e demais regras.

Cada caso é executado dentro de `dbStore.runTestLabEphemeral()` e `withClock()`. Nenhuma fixture do Studio é persistida no datastore real ou espelhada para Postgres. O Studio também repete a trava de ambiente do runner oficial e rejeita execução em produção/ambientes desconhecidos.

Limites de proteção do Studio:

- até 30 dimensões;
- até 25 valores por dimensão;
- até 250 casos por execução;
- o cartesiano acima do limite é recusado em vez de truncado silenciosamente.

Quando uma expectativa é informada, cada caso apresenta **esperado x obtido** e recebe PASS/FAIL. Sem expectativa, o Studio funciona como explorador de comportamento e expõe status, código, policy escolhida, valor considerado, regras aplicadas e variáveis faltantes.

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

`policy.vigencia_inicio` passou a ser regra ACTIVE do motor: a data canônica de emissão do documento é comparada com o início e o fim da vigência, o matching automático considera a vigência histórica e chamadas com `policy_id` explícito passam pela mesma segunda barreira. Documentos anteriores ao início viram pendência `ERR-4021`; data ausente/inválida vira `ERR-4022`; sobreposição ambígua vira `ERR-4023`; e múltiplas apólices sem nenhuma cobertura temporal viram `ERR-4024`. O gate P0 não possui mais exceção nominal: qualquer FAIL ou GAP bloqueia o CI.

P1 mantém gaps planejados do catálogo para regras ainda sem efeito no motor. Eles constam nos relatórios; falhas e gaps de regras ativas bloqueiam o gate. Implementar o comportamento dessas configurações é trabalho de produto distinto da construção do laboratório, e o laboratório não o simula como aprovado.

SEFAZ real, WhatsApp Cloud API e conectores externos continuam dependentes de infraestrutura/credenciais externas. Os testes deste pacote usam os contratos e mocks locais e não comprovam disponibilidade desses serviços externos.

## Adicionar uma regra

1. Cadastre a flag com origem, estado real do motor, estratégia, valores e suíte no catálogo.
2. Acrescente executor com assertions de domínio no runner (ou amplie a família gerada correspondente). As famílias geradas obtêm seus valores do catálogo; a UI não exige componente novo.
3. Execute a auditoria, as suítes e os gates. Sem executor, o resultado permanece GAP. Regras apenas visuais devem permanecer PLANNED até terem comportamento verificável.
4. Preserve o contrato dos IDs de cenários para histórico/reexecução/comparação.
