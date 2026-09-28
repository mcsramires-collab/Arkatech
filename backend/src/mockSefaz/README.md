# Mock SEFAZ — Arckatech

Ambiente local para testar o fluxo de distribuição de DF-e sem depender de um transportador real.

## O que simula

- NF-e, CT-e e MDF-e;
- consulta por `distNSU`;
- NSU sequencial;
- `cStat=138` quando há documentos;
- `cStat=137` quando não há novos documentos;
- `cStat=656` para consumo indevido;
- bloqueio de 1 hora após nova consulta indevida;
- `docZip` em GZip + Base64;
- validação da identidade do CNPJ do certificado;
- mTLS opcional.

O Mock usa sempre `tpAmb=2` (homologação).

## Subir o Mock

```bash
cd backend
npm run mock:sefaz
```

Padrão: `http://localhost:3400`.

O CNPJ de teste das fixtures é `12345678000190`.

### Modo rápido sem mTLS

Envie o header:

```
x-mock-certificate-cnpj: 12345678000190
```

Esse header existe apenas para desenvolvimento local e não é mecanismo de segurança de produção.

### mTLS opcional

Defina:

```
MOCK_SEFAZ_TLS_KEY=/caminho/server.key
MOCK_SEFAZ_TLS_CERT=/caminho/server.crt
MOCK_SEFAZ_TLS_CA=/caminho/dev-ca.crt
```

O servidor passa a exigir certificado cliente. O CN do certificado cliente deve conter o CNPJ usado na consulta.

## Simulador do Local Agent

Com a API Arckatech e o Mock SEFAZ em execução:

```bash
ARCKATECH_API_URL=http://localhost:3000 \
CONNECTOR_TOKEN=<token retornado em POST /tenant/connectors> \
MOCK_SEFAZ_URL=http://localhost:3400 \
MOCK_CNPJ=12345678000190 \
npm run mock:connector:e2e
```

Fluxo executado:

```
sync-config
  -> Mock SEFAZ / distNSU
  -> descompacta docZip
  -> /connector/fiscal-documents
  -> DocumentIngestionService
  -> AverbacaoService
  -> /connector/sync-result
```

Para usar mTLS no simulador:

```
MOCK_CLIENT_PFX_PATH=/caminho/transportadora-teste.pfx
MOCK_CLIENT_PFX_PASSWORD=<senha>
MOCK_SEFAZ_CA_PATH=/caminho/dev-ca.crt
```

## Forçar cenários

No endpoint do mock, use o header de desenvolvimento `x-mock-scenario` com:

- `137`
- `138`
- `656`

Há também `POST /admin/reset` para limpar o estado NSU/bloqueio do mock.
