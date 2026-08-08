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
