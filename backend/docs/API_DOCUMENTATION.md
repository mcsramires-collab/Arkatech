# Guia Oficial de Integração API REST - ARCKATECH Averbações

Este documento fornece as instruções técnicas para integrar sistemas de transporte e embarcadores com a **API ARCKATECH de Averbação de Seguros de Carga** (RCTRC, RCDC, RCV).

---

## 1. Autenticação e Geração de Token JWT

A API utiliza a especificação **OAuth2 Client Credentials**. Cada cliente possui um `client_id` e um `client_secret` únicos fornecidos no momento do cadastro.

### 1.1. Solicitação de Token
- **Endpoint**: `POST /api/v1/auth/token`
- **Headers**: `Content-Type: application/json`

**Exemplo de Payload de Requisição**:
```json
{
  "client_id": "client_teste_11111111000111",
  "client_secret": "secret_123"
}
```

**Exemplo de Resposta de Sucesso**:
```json
{
  "status": "sucesso",
  "token_type": "Bearer",
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 28800,
  "ambiente": "teste",
  "doc_autenticacao": {
    "instrucao": "Inclua este token no cabeçalho HTTP de todas as requisições de averbação.",
    "header_exemplo": "Authorization: Bearer eyJhbGciOiJIUzI1..."
  }
}
```

---

## 2. Endpoint de Averbação de Documentos

- **Endpoint**: `POST /api/v1/averbar`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <seu_access_token>`

### 2.1. Payload de Requisição
```json
{
  "ramo": "RCTRC",
  "xml_content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><cteProc ...></cteProc>"
}
```

### 2.2. Exemplo de Resposta de Sucesso (SUC-2000)
```json
{
  "status": "sucesso",
  "codigo": "SUC-2000",
  "mensagem": "Averbação realizada com sucesso. Número: AVB-RCTRC-849302-A7F2, Timestamp: 2026-08-08T18:50:00Z.",
  "numero_averbacao": "AVB-RCTRC-849302-A7F2",
  "timestamp": "2026-08-08T18:50:00Z",
  "hash_validacao": "7a8f9c0b1d..."
}
```

### 2.3. Exemplo de Resposta de Exceção / Warning (SUC-2001)
*Retornado quando a apólice/usuário encontra-se inativo ou vencido, mas a seguradora possui a flag de liberação habilitada:*
```json
{
  "status": "aviso",
  "codigo": "SUC-2001",
  "mensagem": "Averbação realizada com sucesso AVB-RCV-102938-F1B2, timestamp 2026-08-08T18:50:00Z OBS: Seu cadastro ou apólice se encontra inativo...",
  "numero_averbacao": "AVB-RCV-102938-F1B2",
  "timestamp": "2026-08-08T18:50:00Z"
}
```

### 2.4. Exemplo de Resposta de Variável Faltante (ERR-4004 + Link de Recuperação)
```json
{
  "status": "erro",
  "codigo": "ERR-4004",
  "mensagem": "ERRO 4004: Não foi possível seguir com a sua averbação por não ser localizada a condição Tipo de Embalagem da sua averbação.",
  "variaveis_faltantes": ["Tipo de Embalagem"],
  "recuperacao": {
    "token_recuperacao": "rec_9f8b7a6c5d4e...",
    "url_preenchimento": "http://localhost:5173/recuperar/rec_9f8b7a6c5d4e",
    "instrucao": "O cliente pode preencher a variável pelo link acima ou reenviar a requisição suplementando o campo."
  }
}
```

---

## 3. Tabela de Códigos de Retorno Editáveis

| Código | Tipo | Descrição Padrão (Editável no Banco pelo Admin) |
| :--- | :--- | :--- |
| **SUC-2000** | Sucesso | Averbação realizada com sucesso. Número: `[NUMERO_AVERBACAO]`, Timestamp: `[TIMESTAMP]`. |
| **SUC-2001** | Aviso | Averbação realizada com sucesso `[NUMERO_AVERBACAO]`, timestamp `[TIMESTAMP]` OBS: Seu cadastro encontra-se inativo... |
| **ERR-4001** | Erro | Token de autenticação inválido, expirado ou ausente. |
| **ERR-4002** | Erro | ERRO 4002: O usuário para esta averbação não está ativo, fale com seu corretor ou seguradora. |
| **ERR-4003** | Erro | ERRO 4003: Apólice inativa ou não localizada para o ramo e CNPJ informado. |
| **ERR-4004** | Erro | ERRO 4004: Não foi possível seguir com a sua averbação por não ser localizada a condição `[NOME_VARIAVEL]` da sua averbação. |
| **ERR-4005** | Erro | ERRO 4005: XML malformado ou fora dos padrões mínimos exigidos pelo Sefaz. |
| **ERR-4006** | Erro | ERRO 4006: Variável informada via link de recuperação é inválida ou expirou o tempo limite de preenchimento. |

---

## 4. Recuperação de Variável Faltante

- **Consultar sessão**: `GET /api/v1/averbar/recuperar/:token`
- **Reenviar com a variável preenchida**: `POST /api/v1/averbar/recuperar`
  ```json
  { "recovery_token": "rec_9f8b7a6c5d4e...", "supplemented_vars": { "Tipo de Embalagem": "Container" } }
  ```

---

## 5. Endpoints Administrativos (Painel de Gestão)

Todos abaixo estão sob o prefixo `/api/v1/admin`.

### 5.1. Clientes / Transportadores (`/tenants`)
- `GET /tenants` — lista todos os clientes.
- `POST /tenants` — cria um cliente `{ cnpj, razao_social, ambiente, role, token_duration_hours }`.
- `PUT /tenants/:id` — edita status, ambiente, razão social ou duração do token.

### 5.2. Apólices (`/policies`)
- `GET /policies` — lista apólices.
- `POST /policies` — cria `{ numero_apolice, ramo, tenant_id, insurer_id, broker_id, permitir_inativo_vencido }`.
- `PUT /policies/:id` — edita qualquer campo da apólice.
- `DELETE /policies/:id` — remove a apólice e suas variáveis associadas.

### 5.3. Variáveis de Negócio da Apólice (`/policy-rules`)
Variáveis específicas definidas pela seguradora/corretora para aquela cobertura (ex: "Container", "Valor Declarado").
- `GET /policy-rules`
- `POST /policy-rules` — `{ policy_id, tipo_doc, tag_path, nome_variavel, obrigatoria, exemplo_preenchimento, instrucao_recuperacao }`.
- `PUT /policy-rules/:id` — edita a variável.
- `DELETE /policy-rules/:id`

### 5.4. Regras de Obrigatoriedade por Tipo de Documento (`/document-rules`)
Tags do **padrão Sefaz** exigidas para CT-e, NF-e, NFS-e e MDF-e — valem para todos os documentos daquele tipo, independente da apólice usada. Já nascem cadastradas com `origem: "SEFAZ_PADRAO"` e `observacao: "Obrigatória Sefaz"`; podem ser editadas, ter a obrigatoriedade alternada, ou removidas.
- `GET /document-rules?tipo_documento=CTE`
- `POST /document-rules` — `{ tipo_documento, tag_path, nome_variavel, obrigatoria, observacao }` (nasce com `origem: "CUSTOM"`).
- `PUT /document-rules/:id`
- `DELETE /document-rules/:id`

### 5.5. Textos de Retorno (`/templates`)
- `GET /templates`
- `PUT /templates/:id` — `{ texto_customizado }`.

### 5.6. Gerador de Documentos Fictícios (`/mock/generate`)
Gera um XML de teste completo, no padrão Sefaz, com base no cadastro do transportador.
```json
{
  "tenant_id": "tenant_expressa_teste",
  "tipo_doc": "CTE",
  "policy_id": "pol_rctrc_expressa",
  "incluir_variaveis_apolice": true,
  "omitir_obrigatorias": []
}
```
Quando `incluir_variaveis_apolice` é `true`, as variáveis cadastradas em `/policy-rules` para aquela apólice são escritas no campo de observação (`xObs`/`infCpl`) do XML gerado, no formato `NOME=valor; NOME2=valor2`, e o motor de averbação sabe ler esse campo de volta. Use `omitir_obrigatorias` (lista de nomes de variável) para gerar propositalmente um XML com uma variável obrigatória faltando, e testar o fluxo de recusa/recuperação.

### 5.7. Importação em Lote de XMLs (`/importar-lote`)
`multipart/form-data` com `tenant_id`, `ramo` e um ou mais arquivos no campo `arquivos`. Roda cada XML pelo motor de averbação e retorna o código de sucesso ou recusa de cada um individualmente — útil para validar rapidamente se um lote de documentos averba ou não, e por qual motivo.

### 5.8. Simulador de Carga em Lote Multi-Cliente (`/simulador/executar`, `/simulador/historico`)

### 5.9. Relatório por Cliente ou Conjunto de Clientes (`/relatorio`)
`GET /relatorio?tenant_ids=id1,id2,id3` (omitido = todos os clientes). Retorna total de averbações, sucesso, erro, valor total averbado e quebra por tipo de documento — tanto por cliente quanto consolidado.

### 5.10. Expurgo de Dados de Teste (`/expurgo`)
`POST /expurgo` — `{ dias: 30 }`.

### 5.11. Dashboard (`/dashboard-stats`)

### 5.12. Documentação (`/docs`)
Retorna este mesmo guia em Markdown, para ser renderizado dentro do próprio Portal de Gestão.
