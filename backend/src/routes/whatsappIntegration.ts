import { Router, Response } from 'express';
import { whatsappIntegrationMiddleware } from '../middleware/whatsappIntegrationMiddleware';
import { checkActivated } from '../services/accountActivation';
import { ConnectorFiscalService } from '../services/connectorFiscalService';
import { dbStore } from '../services/dbStore';
import { DocumentIngestionService } from '../services/ingestion/documentIngestion';
import { MultiFormatFiscalParser } from '../services/ingestion/multiFormatFiscalParser';
import { SupportService } from '../services/supportService';
import {
  normalizePhone,
  WhatsappMessageService
} from '../services/whatsappMessageService';
import { XMLParserService } from '../services/xmlParser';
import { SupportTicket } from '../types';

const router = Router();
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

router.use(whatsappIntegrationMiddleware);

router.get('/capabilities', (_req, res) => {
  return res.json({
    status: 'sucesso',
    api: 'WHATSAPP_ADAPTER_V1',
    inbound: {
      kinds: ['TEXT', 'DOCUMENT'],
      document_formats: MultiFormatFiscalParser.supportedExtensions(),
      max_media_bytes: MAX_MEDIA_BYTES,
      tenant_resolution: ['tenant_id', 'tenant_cnpj', 'unique_phone_match'],
      idempotency: 'provider + provider_message_id'
    },
    outbound: {
      delivery: 'polling_outbox',
      statuses: ['PROCESSING', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
      delivery_contract: 'claim -> provider send -> status callback'
    }
  });
});

router.post('/inbound', async (req, res: Response) => {
  const provider = String(req.body.provider || '').trim().toUpperCase();
  const providerMessageId = String(req.body.provider_message_id || '').trim();
  const from = normalizePhone(req.body.from);
  const kind = String(req.body.kind || '').trim().toUpperCase();

  if (!provider || !providerMessageId || !from) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'provider, provider_message_id e from são obrigatórios.'
    });
  }
  if (kind !== 'TEXT' && kind !== 'DOCUMENT') {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'kind deve ser TEXT ou DOCUMENT.'
    });
  }

  const duplicate = WhatsappMessageService.findInbound(provider, providerMessageId);
  if (duplicate) {
    return res.json({
      status: 'sucesso',
      duplicate: true,
      message: duplicate
    });
  }

  const tenant = WhatsappMessageService.resolveTenant({
    tenant_id: req.body.tenant_id ? String(req.body.tenant_id) : undefined,
    tenant_cnpj: req.body.tenant_cnpj ? String(req.body.tenant_cnpj) : undefined,
    phone: from
  });

  if (!tenant) {
    return res.status(422).json({
      status: 'erro',
      codigo: 'WHATSAPP_TENANT_CONTEXT_REQUIRED',
      mensagem:
        'Não foi possível identificar uma única empresa para esta mensagem. O adapter deve informar tenant_id ou tenant_cnpj.'
    });
  }

  if (kind === 'TEXT') {
    const text = String(req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ status: 'erro', mensagem: 'text é obrigatório para kind=TEXT.' });
    }

    const inbound = WhatsappMessageService.createInbound({
      tenant_id: tenant.id,
      provider,
      provider_message_id: providerMessageId,
      phone: from,
      kind: 'TEXT',
      text
    });

    let ticket: SupportTicket | undefined;
    const requestedTicketId = req.body.support_ticket_id
      ? String(req.body.support_ticket_id)
      : undefined;

    if (requestedTicketId) {
      ticket = SupportService.getTicket(tenant.id, requestedTicketId);
      if (!ticket) {
        WhatsappMessageService.markProcessed(inbound, {
          error_message: 'Chamado informado não pertence ao tenant ou não existe.'
        });
        return res.status(404).json({
          status: 'erro',
          codigo: 'SUPPORT_TICKET_NOT_FOUND',
          mensagem: 'Chamado informado não encontrado para esta empresa.'
        });
      }

      SupportService.addTenantMessage({
        ticket,
        author_name: tenant.contato_nome || tenant.razao_social,
        message: text,
        channel: 'WHATSAPP'
      });
    } else {
      ticket = SupportService.createTicket({
        tenant_id: tenant.id,
        assunto: String(req.body.subject || 'Atendimento via WhatsApp'),
        categoria: String(req.body.category || 'WHATSAPP'),
        descricao: text,
        solicitante_nome: tenant.contato_nome || tenant.razao_social,
        prioridade: 'NORMAL',
        canal_origem: 'WHATSAPP'
      });
    }

    WhatsappMessageService.markProcessed(inbound, { support_ticket_id: ticket.id });

    return res.json({
      status: 'sucesso',
      duplicate: false,
      action: requestedTicketId ? 'SUPPORT_MESSAGE_APPENDED' : 'SUPPORT_TICKET_CREATED',
      whatsapp_message_id: inbound.id,
      support_ticket_id: ticket.id
    });
  }

  const filename = String(req.body.document_name || '').trim();
  const mimeType = String(req.body.document_mime_type || 'application/octet-stream').trim();
  const base64 = String(req.body.content_base64 || '').replace(/\s/g, '');

  if (!filename || !base64) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'document_name e content_base64 são obrigatórios para kind=DOCUMENT.'
    });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'INVALID_BASE64',
      mensagem: 'content_base64 inválido.'
    });
  }

  const content = Buffer.from(base64, 'base64');
  if (content.length === 0 || content.length > MAX_MEDIA_BYTES) {
    return res.status(413).json({
      status: 'erro',
      codigo: 'WHATSAPP_MEDIA_SIZE_INVALID',
      mensagem: `O documento deve ter entre 1 byte e ${MAX_MEDIA_BYTES} bytes.`
    });
  }

  const inbound = WhatsappMessageService.createInbound({
    tenant_id: tenant.id,
    provider,
    provider_message_id: providerMessageId,
    phone: from,
    kind: 'DOCUMENT',
    document_name: filename,
    document_mime_type: mimeType,
    content
  });

  const gate = checkActivated(tenant.id);
  if (!gate.ok) {
    WhatsappMessageService.markProcessed(inbound, {
      error_message: 'Conta não ativada para averbação.'
    });
    return res.status(gate.code ?? 403).json(gate.body);
  }

  try {
    const parsedFiles = await MultiFormatFiscalParser.parse({
      originalname: filename,
      mimetype: mimeType,
      buffer: content
    });

    const fiscalDocumentIds: string[] = [];
    const results: any[] = [];
    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const allTenantPolicies = dbStore.policies.filter((policy) => policy.tenant_id === tenant.id);

    for (let index = 0; index < parsedFiles.length; index += 1) {
      const parsedFile = parsedFiles[index]!;
      let parsed;
      try {
        parsed = XMLParserService.parse(parsedFile.content);
      } catch (error) {
        const [ingestion] = DocumentIngestionService.processXmlBatch({
          tenant_id: tenant.id,
          source: 'WHATSAPP',
          app_base_url: appBaseUrl,
          files: [{
            filename: parsedFile.filename,
            xml_content: parsedFile.content,
            capture_mode: 'INTEGRATION',
            external_id: `${provider}:${providerMessageId}:${index + 1}`
          }],
          policies: []
        });

        if (ingestion) fiscalDocumentIds.push(ingestion.fiscal_document_id);
        results.push({
          arquivo: parsedFile.filename,
          fiscal_document_id: ingestion?.fiscal_document_id,
          status: 'ERRO',
          mensagem: error instanceof Error ? error.message : 'Documento fiscal inválido.'
        });
        continue;
      }

      const policies = ConnectorFiscalService.resolveAutomaticPolicies(
        tenant.id,
        parsed.tipoDocumento,
        parsed.dataEmissao
      );
      const notConfigured = allTenantPolicies.length > 0 && policies.length === 0;

      const [ingestion] = DocumentIngestionService.processXmlBatch({
        tenant_id: tenant.id,
        source: 'WHATSAPP',
        app_base_url: appBaseUrl,
        files: [{
          filename: parsedFile.filename,
          xml_content: parsedFile.content,
          capture_mode: 'INTEGRATION',
          external_id: `${provider}:${providerMessageId}:${index + 1}`
        }],
        policies,
        no_policy_status: notConfigured ? 'IGNORADO' : 'RECUSADO',
        no_policy_code: notConfigured ? 'DOCUMENT_TYPE_NOT_CONFIGURED' : 'NO_POLICY_CANDIDATE',
        no_policy_message: notConfigured
          ? `O documento ${parsed.tipoDocumento} chegou via WhatsApp, mas nenhuma apólice está configurada para esse tipo.`
          : 'Documento recebido via WhatsApp, mas nenhuma apólice candidata existe para este cadastro.'
      });

      if (ingestion) fiscalDocumentIds.push(ingestion.fiscal_document_id);
      const fiscalDocument = ingestion
        ? dbStore.fiscalDocuments.find((item) => item.id === ingestion.fiscal_document_id)
        : undefined;

      results.push({
        arquivo: parsedFile.filename,
        fiscal_document_id: ingestion?.fiscal_document_id,
        duplicate: Boolean(ingestion?.duplicate),
        status: fiscalDocument?.status ?? 'ERRO',
        tipo_documento: parsed.tipoDocumento,
        chave_documento: parsed.chaveDocumento,
        averbacao_ids: fiscalDocument?.averbacao_ids ?? [],
        tentativas: ingestion?.tentativas ?? []
      });
    }

    WhatsappMessageService.markProcessed(inbound, { fiscal_document_ids: fiscalDocumentIds });

    return res.json({
      status: 'sucesso',
      duplicate: false,
      action: 'FISCAL_DOCUMENT_INGESTION',
      whatsapp_message_id: inbound.id,
      documentos_extraidos: results.length,
      results
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao interpretar documento.';
    WhatsappMessageService.markProcessed(inbound, { error_message: message });
    return res.status(422).json({
      status: 'erro',
      codigo: 'WHATSAPP_DOCUMENT_PARSE_ERROR',
      mensagem: message,
      whatsapp_message_id: inbound.id
    });
  }
});

router.get('/outbox', (req, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const messages = WhatsappMessageService.outbox(
    Number.isFinite(limitRaw) ? limitRaw : 50
  );

  return res.json({
    status: 'sucesso',
    total: messages.length,
    messages: messages.map((item) => ({
      id: item.id,
      tenant_id: item.tenant_id,
      phone: item.phone,
      kind: item.kind,
      text: item.text,
      support_ticket_id: item.support_ticket_id,
      attempt_count: item.attempt_count ?? 0,
      created_at: item.created_at
    }))
  });
});

router.post('/outbox/claim', (req, res: Response) => {
  const workerId = String(req.body.worker_id || '').trim();
  if (!workerId) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'worker_id é obrigatório para reservar mensagens do outbox.'
    });
  }

  const messages = WhatsappMessageService.claimOutbox({
    worker_id: workerId,
    limit: Number(req.body.limit) || undefined,
    lease_seconds: Number(req.body.lease_seconds) || undefined
  });

  return res.json({
    status: 'sucesso',
    total: messages.length,
    messages: messages.map((item) => ({
      id: item.id,
      tenant_id: item.tenant_id,
      phone: item.phone,
      kind: item.kind,
      text: item.text,
      support_ticket_id: item.support_ticket_id,
      claim_token: item.claim_token,
      claim_expires_at: item.claim_expires_at,
      attempt_count: item.attempt_count ?? 0,
      created_at: item.created_at
    }))
  });
});

router.post('/outbox/:id/status', (req, res: Response) => {
  const status = String(req.body.status || '').toUpperCase();
  const allowed = ['SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
  if (!allowed.includes(status as (typeof allowed)[number])) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'status deve ser SENT, DELIVERED, READ ou FAILED.'
    });
  }

  const message = WhatsappMessageService.updateOutboundStatus({
    id: req.params.id,
    status: status as (typeof allowed)[number],
    provider: req.body.provider ? String(req.body.provider).toUpperCase() : undefined,
    provider_message_id: req.body.provider_message_id
      ? String(req.body.provider_message_id)
      : undefined,
    error_message: req.body.error_message ? String(req.body.error_message) : undefined,
    claim_token: req.body.claim_token ? String(req.body.claim_token) : undefined
  });

  if (!message) {
    return res.status(404).json({ status: 'erro', mensagem: 'Mensagem de saída não encontrada.' });
  }

  return res.json({ status: 'sucesso', message });
});

export default router;
