import { Router } from 'express';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { dbStore } from '../services/dbStore';
import { SupportService } from '../services/supportService';
import { SupportChannel, SupportTicketStatus } from '../types';
import { apenasInternalUser } from './adminHelpers';

const router = Router();

router.get('/support/tickets', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;

  let items = [...dbStore.supportTickets];
  if (req.query.status) {
    const status = String(req.query.status).toUpperCase();
    items = items.filter((ticket) => ticket.status === status);
  }
  if (req.query.tenant_id) {
    items = items.filter((ticket) => ticket.tenant_id === String(req.query.tenant_id));
  }
  if (req.query.prioridade) {
    const priority = String(req.query.prioridade).toUpperCase();
    items = items.filter((ticket) => ticket.prioridade === priority);
  }

  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return res.json({
    status: 'sucesso',
    total: items.length,
    tickets: items.map((ticket) => ({
      ...ticket,
      mensagens: dbStore.supportMessages.filter((message) => message.ticket_id === ticket.id).length
    }))
  });
});

router.get('/support/tickets/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;

  const ticket = dbStore.supportTickets.find((item) => item.id === req.params.id);
  if (!ticket) {
    return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
  }

  return res.json({
    status: 'sucesso',
    ticket,
    messages: SupportService.messages(ticket.id, ticket.tenant_id)
  });
});

router.put('/support/tickets/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;

  const ticket = dbStore.supportTickets.find((item) => item.id === req.params.id);
  if (!ticket) {
    return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
  }

  const allowedStatus: SupportTicketStatus[] = [
    'ABERTO', 'EM_ATENDIMENTO', 'AGUARDANDO_CLIENTE', 'RESOLVIDO', 'FECHADO'
  ];
  const status = req.body.status
    ? String(req.body.status).toUpperCase() as SupportTicketStatus
    : undefined;
  if (status && !allowedStatus.includes(status)) {
    return res.status(400).json({ status: 'erro', mensagem: 'status de chamado inválido.' });
  }

  const priorities = ['BAIXA', 'NORMAL', 'ALTA', 'CRITICA'] as const;
  const prioridade = req.body.prioridade
    ? String(req.body.prioridade).toUpperCase() as (typeof priorities)[number]
    : undefined;
  if (prioridade && !priorities.includes(prioridade)) {
    return res.status(400).json({ status: 'erro', mensagem: 'prioridade inválida.' });
  }

  const updated = SupportService.updateTicket({
    ticket,
    status,
    prioridade,
    assigned_to:
      req.body.assigned_to !== undefined ? String(req.body.assigned_to || '') : undefined
  });

  return res.json({ status: 'sucesso', ticket: updated });
});

router.post('/support/tickets/:id/messages', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;

  const ticket = dbStore.supportTickets.find((item) => item.id === req.params.id);
  if (!ticket) {
    return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
  }

  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ status: 'erro', mensagem: 'message é obrigatório.' });
  }

  const allowedChannels: SupportChannel[] = ['CHAT', 'PORTAL', 'WHATSAPP', 'TELEFONE'];
  const channel = String(req.body.channel || 'CHAT').toUpperCase() as SupportChannel;
  if (!allowedChannels.includes(channel)) {
    return res.status(400).json({ status: 'erro', mensagem: 'channel inválido.' });
  }

  const entry = SupportService.addInternalMessage({
    ticket,
    author_id: req.backoffice?.user_id,
    author_name: req.backoffice?.nome || 'Arckatech',
    message,
    channel
  });

  return res.json({ status: 'sucesso', message: entry, ticket });
});

export default router;
