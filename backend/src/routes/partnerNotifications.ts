import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Policy, PartnerChangeNotification } from '../types';
import { sendPartnerChangeNotificationEmail } from '../services/emailService';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';

/**
 * Notificação de Embarques Retroativos (pacote de 23/09, compartilhado pelo usuário) — quando
 * `POST /admin/policies/:id/trocar-parceria` (adminPacote2109.ts) recebe uma `vigencia_inicio`
 * retroativa, a corretora nova precisa decidir se assume a responsabilidade pelos embarques já
 * feitos desde aquela data. Extraído para arquivo próprio (não misturado em adminPacote2109.ts)
 * só por organização — mesmo prefixo /api/v1/admin, montado em admin.ts.
 */
const router = Router();

/** 2 dias úteis (pula sábado/domingo) a partir de agora — decisão do usuário, mesmo prazo do
 *  comportamento original descrito nos relatórios de negócio do wizard. */
function calcularPrazoDoisDiasUteis(): string {
  let diasUteisRestantes = 2;
  const data = new Date();
  while (diasUteisRestantes > 0) {
    data.setDate(data.getDate() + 1);
    const diaSemana = data.getDay(); // 0 = domingo, 6 = sábado
    if (diaSemana !== 0 && diaSemana !== 6) diasUteisRestantes--;
  }
  return data.toISOString();
}

/** Marca EXPIRADO de forma preguiçosa (mesmo padrão do resto do sistema — sem job/cron) qualquer
 *  notificação PENDENTE cujo prazo já passou, na hora de ler ou responder. */
function expirarSeNecessario(notif: PartnerChangeNotification): PartnerChangeNotification {
  if (notif.status === 'PENDENTE' && new Date(notif.prazo_limite).getTime() < Date.now()) {
    notif.status = 'EXPIRADO';
  }
  return notif;
}

/**
 * Chamada por `POST /admin/policies/:id/trocar-parceria` quando a nova vigência é retroativa —
 * cria o registro e dispara o e-mail. Nunca lança: uma falha no envio de e-mail não pode derrubar
 * a troca de parceria em si (mesmo padrão de `criarEEnviarConvite` em adminSeguradora1.ts).
 */
export async function criarNotificacaoSeRetroativa(
  policy: Policy,
  papel: 'lider' | 'cocorretora' | 'assessoria',
  brokerId: string,
  vigenciaInicio: string
): Promise<void> {
  if (new Date(vigenciaInicio).getTime() >= Date.now()) return; // não é retroativa — nada a fazer

  const broker = dbStore.brokers.find((b) => b.id === brokerId);
  const prazoLimite = calcularPrazoDoisDiasUteis();

  const notif: PartnerChangeNotification = {
    id: uuidv4(),
    policy_id: policy.id,
    broker_id: brokerId,
    papel,
    vigencia_inicio: vigenciaInicio,
    status: 'PENDENTE',
    prazo_limite: prazoLimite,
    created_at: new Date().toISOString()
  };
  dbStore.partnerChangeNotifications.push(notif);
  dbStore.persist();

  const destino = broker?.corretor_responsavel_email;
  if (!destino) return; // sem e-mail cadastrado — registro fica criado, só o envio é pulado

  const respostaUrl = `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/notificacoes-parceria/${notif.id}`;
  await sendPartnerChangeNotificationEmail({
    to: destino,
    nomeDestinatario: broker?.corretor_responsavel_nome || broker?.nome_fantasia || broker?.nome || '',
    numeroApolice: policy.numero_apolice,
    papel,
    dataRetroativa: vigenciaInicio,
    prazoLimite,
    respostaUrl
  });
}

// --- GET /admin/partner-change-notifications?broker_id=&status= ---
// Corretora vê só as suas (via broker_id do próprio token); ADM/seguradora podem listar mais
// amplo (seguradora não filtra por padrão — a notificação é entre Arckatech/corretora, não tem
// insurer_id direto; fica como filtro opcional igual a outras listagens administrativas).
router.get('/partner-change-notifications', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const ator = req.backoffice;
  let items = dbStore.partnerChangeNotifications;

  if (ator?.actor_type === 'CORRETORA') {
    if (!ator.broker_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma corretora — sem acesso a esta área.' });
    }
    items = items.filter((n) => n.broker_id === ator.broker_id);
  } else if (ator?.actor_type !== 'INTERNAL_USER' && ator?.actor_type !== 'SEGURADORA') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de corretoras, seguradoras e da administração Arckatech.' });
  } else if (req.query.broker_id) {
    items = items.filter((n) => n.broker_id === req.query.broker_id);
  }

  if (req.query.status) items = items.filter((n) => n.status === req.query.status);

  items = items.map(expirarSeNecessario);
  dbStore.persist();
  return res.json({ status: 'sucesso', notificacoes: items });
});

// --- POST /admin/partner-change-notifications/:id/responder ---
router.post(
  '/partner-change-notifications/:id/responder',
  requirePermission('delegacao_corretora', 'editar'),
  (req: BackofficeAuthenticatedRequest, res) => {
    const { id } = req.params;
    const notif = dbStore.partnerChangeNotifications.find((n) => n.id === id);
    if (!notif) {
      return res.status(404).json({ status: 'erro', mensagem: 'Notificação não encontrada.' });
    }

    const ator = req.backoffice;
    if (ator?.actor_type === 'CORRETORA' && notif.broker_id !== ator.broker_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Esta notificação não pertence à sua corretora.' });
    }
    if (ator?.actor_type !== 'CORRETORA' && ator?.actor_type !== 'INTERNAL_USER' && ator?.actor_type !== 'SEGURADORA') {
      return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de corretoras, seguradoras e da administração Arckatech.' });
    }

    expirarSeNecessario(notif);
    if (notif.status !== 'PENDENTE') {
      return res.status(409).json({
        status: 'erro',
        mensagem: `Esta notificação já não está mais pendente (status atual: ${notif.status}).`
      });
    }

    const { resposta } = req.body;
    if (resposta !== 'ACEITO' && resposta !== 'RECUSADO') {
      return res.status(400).json({ status: 'erro', mensagem: "resposta deve ser 'ACEITO' ou 'RECUSADO'." });
    }

    notif.status = resposta;
    notif.respondido_em = new Date().toISOString();
    dbStore.persist();
    return res.json({ status: 'sucesso', notificacao: notif });
  }
);

export default router;
