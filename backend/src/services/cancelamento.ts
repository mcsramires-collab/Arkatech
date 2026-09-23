import { dbStore } from './dbStore';
import { Averbacao } from '../types';
import { XMLParserService } from './xmlParser';
import { RuleEngineService } from './ruleEngine';
import { ResponseEngine } from './responseEngine';

export interface CancelamentoResultDTO {
  status: 'sucesso' | 'erro';
  codigo: string;
  mensagem: string;
  averbacao?: Averbacao;
}

/**
 * Motor de Cancelamento pós-averbação (pacote de 23/09, compartilhado pelo usuário) — decisão
 * tomada com o usuário: cancelamento exige o evento de cancelamento REAL do Sefaz (tpEvento
 * 110111), não um simples registro em texto. Duas portas de entrada:
 * - `POST /tenant/averbacoes/:id/cancelar` (segurado, self-service, só dentro do prazo
 *   configurado na apólice — `RuleEngineService.getBusinessConfig` chaves
 *   `regras:prazo-cancelamento-valor`/`regras:prazo-cancelamento-unidade`).
 * - `POST /admin/averbacoes/:id/cancelar-averbado` (seguradora/ADM, sem restrição de prazo).
 * Ambas chamam `processar` abaixo, só variando `requisitante` e se checam prazo.
 *
 * Decisão de escopo registrada aqui, por falta de confirmação explícita do usuário: fora do
 * prazo, o segurado recebe ERR-4018 e é orientado a falar com a seguradora — não existe (ainda)
 * uma fila de "pedido de cancelamento fora do prazo" separada, no estilo da fila
 * PENDENTE_APROVACAO. Fácil de adicionar depois seguindo o mesmo padrão, se fizer falta.
 */
export class CancelamentoService {
  public static processar(params: {
    averbacaoAnterior: Averbacao;
    xmlEvento: string;
    requisitante: 'SEGURADO' | 'SEGURADORA';
  }): CancelamentoResultDTO {
    const { averbacaoAnterior, xmlEvento, requisitante } = params;

    if (averbacaoAnterior.status !== 'SUCESSO') {
      const fmt = ResponseEngine.formatResponse('ERR-4020');
      return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
    }

    const policy = dbStore.policies.find((p) => p.id === averbacaoAnterior.policy_id);
    if (!policy) {
      const fmt = ResponseEngine.formatResponse('ERR-4003');
      return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
    }

    // Self-service (segurado): só dentro do prazo configurado. Ausência de configuração =
    // cancelamento por conta própria NÃO habilitado (default seguro — a seguradora precisa optar
    // explicitamente, mesmo padrão de "a chave precisa EXISTIR" já usado em Prazos e Datas, só que
    // aqui invertido: lá a ausência nunca bloqueia, aqui a ausência nunca libera).
    if (requisitante === 'SEGURADO') {
      const businessConfig = RuleEngineService.getBusinessConfig(policy);
      const prazoValor = Number(businessConfig['regras:prazo-cancelamento-valor']);
      const prazoUnidade = businessConfig['regras:prazo-cancelamento-unidade'] === 'Horas' ? 'Horas' : 'Dias';

      const configuradoEValido =
        'regras:prazo-cancelamento-valor' in businessConfig && !isNaN(prazoValor) && prazoValor > 0;

      if (!configuradoEValido) {
        const fmt = ResponseEngine.formatResponse('ERR-4018');
        return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
      }

      const unidadeMs = prazoUnidade === 'Horas' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const limite = new Date(new Date(averbacaoAnterior.timestamp).getTime() + prazoValor * unidadeMs);
      if (Date.now() > limite.getTime()) {
        const fmt = ResponseEngine.formatResponse('ERR-4018');
        return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
      }
    }

    let parsed;
    try {
      parsed = XMLParserService.parseEventoCancelamento(xmlEvento);
    } catch (err: any) {
      const fmt = ResponseEngine.formatResponse('ERR-4019', { MOTIVO: err.message });
      return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
    }

    if (parsed.tipoEvento !== '110111') {
      const fmt = ResponseEngine.formatResponse('ERR-4019', {
        MOTIVO: `tipo de evento '${parsed.tipoEvento}' não é um cancelamento (esperado: 110111)`
      });
      return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
    }

    const norm = (v?: string) => (v ?? '').replace(/\D/g, '');
    if (norm(parsed.chaveDocumentoCancelado) !== norm(averbacaoAnterior.chave_documento)) {
      const fmt = ResponseEngine.formatResponse('ERR-4019', {
        MOTIVO: 'a chave do documento no evento não confere com a chave desta averbação'
      });
      return { status: 'erro', codigo: fmt.codigo, mensagem: fmt.mensagem };
    }

    averbacaoAnterior.status = 'CANCELADO';
    averbacaoAnterior.protocolo_cancelamento_sefaz = parsed.protocoloEvento;
    averbacaoAnterior.justificativa_cancelamento = parsed.justificativa;
    averbacaoAnterior.cancelado_em = new Date().toISOString();
    averbacaoAnterior.cancelado_por = requisitante;
    dbStore.persist();

    const fmt = ResponseEngine.formatResponse('SUC-2002', {
      PROTOCOLO_CANCELAMENTO: parsed.protocoloEvento ?? 'não informado no evento'
    });
    return { status: 'sucesso', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao: averbacaoAnterior };
  }
}
