import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import { Tenant, Policy, RamoApolice, Averbacao, RecoverySession, RawXMLStore } from '../types';
import { XMLParserService } from './xmlParser';
import { RuleEngineService } from './ruleEngine';
import { ResponseEngine } from './responseEngine';

export interface AverbacaoRequestDTO {
  tenant_id: string;
  ramo: RamoApolice;
  /**
   * Opcional — permite ao chamador apontar exatamente qual apólice usar (id), em vez de deixar
   * o motor resolver por tenant_id + ramo (ver passo 4 de process()). Usado pelo seletor de
   * apólices ativas do Portal do Segurado (o segurado escolhe a apólice diretamente, não mais só
   * o ramo) e pela rota de recuperação (`POST /tenant/recovery/:token/corrigir`), que já sabe o
   * policy_id exato da sessão de recuperação. Quando ausente, mantém o comportamento legado de
   * resolver por ramo (usado hoje pelas rotas /admin).
   */
  policy_id?: string;
  xml_content: string;
  recovery_token?: string;
  supplemented_vars?: Record<string, any>;
  /**
   * Fase 4 do pacote de 21/09 (Tratamento de Recusas, Bloco 1 — estratégia 'exigir-codigo') —
   * código de liberação (Averbação Esporádica) para destravar um valor acima do LMI/sublimite.
   * Aplicado só à checagem de LMI (9b); sublimites (9c) nunca consomem um código — ver comentário
   * em avaliarLimiteComEstrategia.
   */
  codigo_liberacao?: string;
}

export interface AverbacaoResponseDTO {
  status: 'sucesso' | 'erro' | 'aviso' | 'pendente';
  codigo: string;
  mensagem: string;
  averbacao_id?: string;
  numero_averbacao?: string;
  protocolo_interno_averbacao?: string;
  valor_considerado_averbacao?: number;
  regras_internas_aplicadas?: string[];
  timestamp?: string;
  hash_validacao?: string;
  variaveis_faltantes?: string[];
  explicacao_nao_tecnica?: string;
  orientacao_correcao?: string;
  recuperacao?: {
    token_recuperacao: string;
    url_preenchimento: string;
    instrucao: string;
  };
}

export class AverbacaoService {
  private static erro(
    codigo: string,
    replacements: Record<string, string> = {},
    extra: Partial<AverbacaoResponseDTO> = {}
  ): AverbacaoResponseDTO {
    const fmt = ResponseEngine.formatResponse(codigo, replacements);
    return {
      status: 'erro',
      codigo: fmt.codigo,
      mensagem: fmt.mensagem,
      explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
      orientacao_correcao: fmt.orientacao_correcao,
      ...extra
    };
  }

  /**
   * Persiste um registro de Averbacao com status='ERRO' para documentos rejeitados DEPOIS que já
   * sabemos a qual apólice/policy_id o documento se refere (titularidade, deduplicação, apólice
   * vencida/cadastro inativo). Rejeições anteriores a esse ponto (tenant não encontrado, XML
   * inválido, token de recuperação inválido) não têm policy_id e por isso não geram este
   * registro — a única exceção histórica é ERR-4004 (variável faltante), que já é rastreada via
   * RecoverySession em vez de Averbacao.
   */
  private static persistErro(
    tenant: Tenant,
    policy: Policy,
    parsedDoc: ReturnType<typeof XMLParserService.parse>,
    rawXmlId: string,
    fmt: { codigo: string; mensagem: string },
    regrasAplicadas: string[]
  ): void {
    const timestampISO = new Date().toISOString();
    const erroRecord: Averbacao = {
      id: uuidv4(),
      protocolo_interno_averbacao: `PI-${uuidv4()}`,
      tenant_id: tenant.id,
      policy_id: policy.id,
      status: 'ERRO',
      codigo_resposta: fmt.codigo,
      mensagem_resposta: fmt.mensagem,
      valor_carga: parsedDoc.valorCarga,
      valor_considerado_averbacao: parsedDoc.valorCarga,
      regras_internas_aplicadas: regrasAplicadas,
      tp_amb_sefaz: parsedDoc.tpAmbSefaz,
      tipo_documento: parsedDoc.tipoDocumento,
      chave_documento: parsedDoc.chaveDocumento,
      numero_documento: parsedDoc.numeroDocumento,
      serie_documento: parsedDoc.serie,
      cnpj_emissor: parsedDoc.cnpjEmitente,
      cnpj_remetente: parsedDoc.cnpjRemetente,
      cnpj_destinatario: parsedDoc.cnpjDestinatario,
      cnpj_tomador: parsedDoc.cnpjTomador,
      protocolo_aceitacao_sefaz: parsedDoc.protocoloAceitacaoSefaz,
      raw_xml_id: rawXmlId,
      ambiente: tenant.ambiente,
      timestamp: timestampISO,
      created_at: timestampISO
    };
    dbStore.averbacoes.unshift(erroRecord);
    dbStore.persist();
  }

  /**
   * Fase 4 do pacote de 21/09 (Tratamento de Recusas / Documentos Pendentes) — mesma ideia de
   * `persistErro`, mas grava status='PENDENTE_APROVACAO' em vez de 'ERRO': o motivo de recusa
   * (`codigo`) fica em `motivo_pendencia`, e `codigo_resposta`/`mensagem_resposta` recebem o
   * mesmo texto por enquanto (são atualizados de verdade quando a seguradora decidir, via
   * `POST /admin/averbacoes/:id/decidir`). Devolve o registro criado (não só grava) porque quem
   * chama precisa do `id` para montar a resposta HTTP (`averbacao_id`).
   */
  private static persistPendente(
    tenant: Tenant,
    policy: Policy,
    parsedDoc: ReturnType<typeof XMLParserService.parse>,
    rawXmlId: string,
    fmt: { codigo: string; mensagem: string },
    regrasAplicadas: string[],
    valorConsiderado?: number,
    lmiSnapshot?: number,
    sublimiteSnapshot?: number
  ): Averbacao {
    const timestampISO = new Date().toISOString();
    const pendenteRecord: Averbacao = {
      id: uuidv4(),
      protocolo_interno_averbacao: `PI-${uuidv4()}`,
      tenant_id: tenant.id,
      policy_id: policy.id,
      status: 'PENDENTE_APROVACAO',
      motivo_pendencia: fmt.codigo,
      codigo_resposta: fmt.codigo,
      mensagem_resposta: fmt.mensagem,
      valor_carga: parsedDoc.valorCarga,
      valor_considerado_averbacao: valorConsiderado ?? parsedDoc.valorCarga,
      lmi_no_momento_envio: lmiSnapshot,
      sublimite_no_momento_envio: sublimiteSnapshot,
      regras_internas_aplicadas: regrasAplicadas,
      tp_amb_sefaz: parsedDoc.tpAmbSefaz,
      tipo_documento: parsedDoc.tipoDocumento,
      chave_documento: parsedDoc.chaveDocumento,
      numero_documento: parsedDoc.numeroDocumento,
      serie_documento: parsedDoc.serie,
      cnpj_emissor: parsedDoc.cnpjEmitente,
      cnpj_remetente: parsedDoc.cnpjRemetente,
      cnpj_destinatario: parsedDoc.cnpjDestinatario,
      cnpj_tomador: parsedDoc.cnpjTomador,
      protocolo_aceitacao_sefaz: parsedDoc.protocoloAceitacaoSefaz,
      raw_xml_id: rawXmlId,
      ambiente: tenant.ambiente,
      timestamp: timestampISO,
      created_at: timestampISO
    };
    dbStore.averbacoes.unshift(pendenteRecord);
    dbStore.persist();
    return pendenteRecord;
  }

  /**
   * Fase 4 — decide o destino de um excedente de LMI/sublimite conforme a estratégia configurada
   * em Tratamento de Recusas (Bloco 1, `PolicyBusinessSettings.config`, chaves `regras:*` — ainda
   * um blob genérico, ver gap registrado no documento de validação técnica). Valores possíveis de
   * `regras:estrategia-lmg` (default `'exigir-codigo'`, igual ao padrão descrito no relatório):
   * - `'exigir-codigo'`: só passa com um `LiberationCode` válido para o excedente; sem código
   *   informado ou código inválido/expirado/esgotado/insuficiente → recusa direto (não enfileira
   *   — sem código não há o que esperar).
   * - `'sem-codigo'` + `regras:sem-codigo-modo === 'teto'`: dentro do teto (`regras:teto-valor`)
   *   passa direto; acima do teto, vai para `regras:teto-acima-acao` (`'fila'` → pendente,
   *   `'recusar'` → recusa direto).
   * - `'sem-codigo'` + modo `'fila-sempre'`: qualquer excedente vira pendente.
   * - `'aceitar-sem-trava'`: passa sempre, mesmo acima do limite.
   * - `'truncar'`: passa, mas o valor considerado é limitado ao teto (LMI/sublimite) — nunca gera
   *   pendência nem recusa.
   * Sublimites (9c) NUNCA consomem `codigo_liberacao` — os campos do código (`valor_carga_liberado`
   * etc.) são pensados no nível da apólice/LMI, não por sublimite específico; um excedente de
   * sublimite sob estratégia `'exigir-codigo'` sempre recusa direto (não enfileira, mesmo padrão
   * de "sem código não há o que esperar").
   */
  private static avaliarLimiteComEstrategia(params: {
    valorConsiderado: number;
    limite: number;
    tipoLimite: 'LMI' | 'SUBLIMITE';
    businessConfig: Record<string, any>;
    policy: Policy;
    codigoLiberacaoInformado?: string;
  }): { resultado: 'aprovado' | 'pendente' | 'recusado'; valorFinal: number; codigoConsumido?: string } {
    const { valorConsiderado, limite, tipoLimite, businessConfig, policy, codigoLiberacaoInformado } = params;
    const estrategia = businessConfig['regras:estrategia-lmg'] ?? 'exigir-codigo';

    if (estrategia === 'aceitar-sem-trava') {
      return { resultado: 'aprovado', valorFinal: valorConsiderado };
    }
    if (estrategia === 'truncar') {
      return { resultado: 'aprovado', valorFinal: Math.min(valorConsiderado, limite) };
    }
    if (estrategia === 'exigir-codigo') {
      if (tipoLimite === 'SUBLIMITE' || !codigoLiberacaoInformado) {
        return { resultado: 'recusado', valorFinal: valorConsiderado };
      }
      const codigoNormalizado = codigoLiberacaoInformado.trim().toUpperCase();
      const codigo = dbStore.liberationCodes.find(
        (c) => c.policy_id === policy.id && c.codigo.trim().toUpperCase() === codigoNormalizado
      );
      const excedente = valorConsiderado - limite;
      const codigoValido =
        codigo &&
        codigo.ativo &&
        new Date(codigo.validade).getTime() >= Date.now() &&
        (codigo.usos_maximos === undefined || codigo.usos_realizados < codigo.usos_maximos) &&
        (codigo.valor_carga_liberado === undefined || codigo.valor_carga_liberado >= excedente);
      if (!codigoValido) {
        return { resultado: 'recusado', valorFinal: valorConsiderado };
      }
      codigo!.usos_realizados += 1;
      return { resultado: 'aprovado', valorFinal: valorConsiderado, codigoConsumido: codigo!.codigo };
    }
    // 'sem-codigo'
    const modo = businessConfig['regras:sem-codigo-modo'] ?? 'fila-sempre';
    if (modo === 'fila-sempre') {
      return { resultado: 'pendente', valorFinal: valorConsiderado };
    }
    // modo === 'teto'
    const teto = Number(businessConfig['regras:teto-valor']);
    if (!isNaN(teto) && valorConsiderado <= teto) {
      return { resultado: 'aprovado', valorFinal: valorConsiderado };
    }
    const acaoAcimaTeto = businessConfig['regras:teto-acima-acao'] ?? 'fila';
    return { resultado: acaoAcimaTeto === 'recusar' ? 'recusado' : 'pendente', valorFinal: valorConsiderado };
  }

  /** Faz o parse de "DD/MM/AAAA" (formato da variável DATA_EMBARQUE) para Date local. undefined se inválido. */
  private static parseDataEmbarqueBR(value: string): Date | undefined {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
    if (!m) return undefined;
    const [, d, mo, y] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(date.getTime()) ? undefined : date;
  }

  /**
   * Checa os Blocos 1 e 2 de "Prazos e Datas" (Regras de Negócio da apólice — ver comentário no
   * passo 9d de process()). Retorna null quando não há nada a bloquear (inclusive quando a
   * seguradora nunca configurou nada nesta apólice, ou quando falta dado suficiente pra avaliar
   * um prazo — nesse caso preferimos não bloquear a arriscar um falso positivo).
   */
  private static checkPrazos(
    businessConfig: Record<string, any>,
    tagsMap: Record<string, any>
  ): { codigo: string; replacements: Record<string, string> } | null {
    const dataEmbarqueRaw = tagsMap['DATA_EMBARQUE'];
    const dataEmbarque =
      typeof dataEmbarqueRaw === 'string' ? this.parseDataEmbarqueBR(dataEmbarqueRaw) : undefined;

    if (dataEmbarque) {
      // "Quando encontrada no XML, esta data tem prioridade sobre o Prazo de Emissão" — Bloco 2
      // (Regra de Prazo de Embarque). Só aplica se a seguradora configurou algo diferente do
      // padrão "nunca" (chave pode nem existir — nesse caso também não bloqueia).
      const prazoEmbarque = businessConfig['regras:prazo-embarque'];
      if (!prazoEmbarque || prazoEmbarque === 'nunca') return null;

      const inicioDiaEmbarque = new Date(
        dataEmbarque.getFullYear(),
        dataEmbarque.getMonth(),
        dataEmbarque.getDate()
      );
      const fimDiaEmbarque = new Date(inicioDiaEmbarque.getTime() + 24 * 60 * 60 * 1000 - 1);

      let limite: Date;
      if (prazoEmbarque === 'antes') {
        // "Deve averbar antes do embarque" -> até 23h59m59 do dia ANTERIOR ao embarque.
        limite = new Date(inicioDiaEmbarque.getTime() - 1);
      } else if (prazoEmbarque === 'dia') {
        limite = fimDiaEmbarque;
      } else if (prazoEmbarque === 'apos') {
        const dias = Number(businessConfig['regras:dias-apos']);
        const diasValidos = !isNaN(dias) && dias > 0 ? dias : 0;
        limite = new Date(fimDiaEmbarque.getTime() + diasValidos * 24 * 60 * 60 * 1000);
      } else {
        return null;
      }

      if (Date.now() > limite.getTime()) {
        return {
          codigo: 'ERR-4015',
          replacements: {
            DATA_EMBARQUE: dataEmbarqueRaw,
            PRAZO_LIMITE: limite.toLocaleString('pt-BR')
          }
        };
      }
      return null;
    }

    // Sem Data de Embarque no documento: cai no Bloco 1 (Prazo de Emissão) — só se a seguradora
    // salvou explicitamente um prazo nesta apólice (a chave precisa EXISTIR no config; ver
    // RuleEngineService.getBusinessConfig — nunca assumimos os 90 dias exibidos como padrão na
    // tela para uma apólice que nunca configurou nada).
    if (!('regras:prazo-valor' in businessConfig)) return null;

    const campoBase = businessConfig['regras:prazo-campo'] === 'dhRecBto' ? 'dhRecBto' : 'dhEmi';
    const dataBaseRaw = tagsMap[campoBase];
    if (!dataBaseRaw) return null; // sem a data-base não dá pra avaliar o prazo — nunca bloqueia por isso

    const dataBase = new Date(dataBaseRaw);
    if (isNaN(dataBase.getTime())) return null;

    const prazoValor = Number(businessConfig['regras:prazo-valor']);
    if (isNaN(prazoValor) || prazoValor <= 0) return null;

    const unidadeMs = businessConfig['regras:prazo-unidade'] === 'Horas' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const limite = new Date(dataBase.getTime() + prazoValor * unidadeMs);

    if (Date.now() > limite.getTime()) {
      return {
        codigo: 'ERR-4014',
        replacements: {
          DATA_BASE: dataBase.toLocaleString('pt-BR'),
          PRAZO_LIMITE: limite.toLocaleString('pt-BR')
        }
      };
    }
    return null;
  }

  /**
   * Processa a solicitação de averbação de um documento fiscal.
   */
  public static process(dto: AverbacaoRequestDTO, appBaseUrl: string = 'http://localhost:5173'): AverbacaoResponseDTO {
    // 1. Localizar o Cliente / Tenant
    const tenant = dbStore.tenants.find((t) => t.id === dto.tenant_id);
    if (!tenant) {
      return this.erro('ERR-4001');
    }

    // 2. Se for um envio de recuperação via Token existente
    let recoverySession: RecoverySession | undefined;
    if (dto.recovery_token) {
      recoverySession = dbStore.recoverySessions.find(
        (r) => r.token === dto.recovery_token && !r.utilizada
      );
      if (!recoverySession) {
        return this.erro('ERR-4006');
      }
      // Achado da auditoria de 27/08 (Documentos Pendentes): "expira_em" era gravado e exibido
      // na tela (Portal do Segurado e link de e-mail) como um prazo real de 24h, mas nunca era
      // checado aqui — um token "expirado" continuava sendo aceito indefinidamente. Corrigido:
      // passado o prazo, o token deixa de valer e o documento precisa ser reenviado (o cliente
      // não tinha como saber que aquela pendência nunca mais seria averbável antes desta correção).
      if (new Date(recoverySession.expira_em).getTime() <= Date.now()) {
        return this.erro('ERR-4012', { EXPIRA_EM: recoverySession.expira_em });
      }
    }

    // 3. Parse do Documento XML / JSON
    const contentToParse = dto.xml_content || recoverySession?.raw_xml_content || '';
    let parsedDoc;
    try {
      parsedDoc = XMLParserService.parse(contentToParse);
    } catch (err: any) {
      return this.erro('ERR-4005');
    }

    // 4. Buscar a Apólice a usar
    //
    // Dois caminhos:
    // a) policy_id explícito (dto.policy_id) — usado pelo seletor de apólices ativas do Portal
    //    do Segurado (a pessoa escolhe a apólice diretamente) e pela rota de recuperação, que já
    //    sabe exatamente qual policy_id a sessão pendente pertence. Resolução direta e sem
    //    ambiguidade: se o id não existir OU não pertencer a este tenant, é tratado como
    //    "nenhuma apólice encontrada" (ERR-4016) — nunca vazamos a existência de uma apólice de
    //    outro tenant através da mensagem de erro.
    // b) Legado, por ramo (RCTRC, RCDC, RCV) — mantido para quem ainda não migrou para
    //    policy_id (ex: rotas /admin). Bug corrigido em 29/08: antes, .find() retornava a
    //    PRIMEIRA apólice que batesse tenant_id + ramo, sem considerar status/vigência. Se o
    //    tenant tivesse mais de uma apólice para o mesmo ramo (ex: uma antiga vencida/inativa e
    //    uma nova ativa), o motor podia acabar pegando a errada mesmo havendo uma apólice ativa
    //    de verdade disponível. Agora damos preferência explícita a uma apólice ATIVA e dentro
    //    da vigência quando houver mais de uma opção para o mesmo ramo; só caímos numa apólice
    //    inativa/vencida se não houver nenhuma ativa — nesse caso os passos 7+ seguem dando o
    //    motivo específico (ERR-4002/4003/4011).
    let policy: Policy | undefined;
    if (dto.policy_id) {
      policy = dbStore.policies.find((p) => p.id === dto.policy_id && p.tenant_id === tenant.id);
    } else {
      const policiesDoRamo = dbStore.policies.filter(
        (p) => p.tenant_id === tenant.id && p.ramo === dto.ramo
      );
      const isPolicyUsavel = (p: Policy) =>
        p.status === 'ATIVA' &&
        !(p.vigencia_fim && new Date(p.vigencia_fim).getTime() < Date.now());
      policy = policiesDoRamo.find(isPolicyUsavel) || policiesDoRamo[0];
    }

    if (!policy) {
      // Diferente de ERR-4003 (apólice ENCONTRADA mas com cadastro inativo, ver passo 7): aqui
      // não existe NENHUMA apólice cadastrada para este tenant+ramo (ou o policy_id informado não
      // pertence a este tenant). Código próprio para a mensagem não confundir "apólice inativa"
      // com "apólice não encontrada" — achado da auditoria de 29/08 junto com o bug do .find()
      // acima. Como não há policy_id resolvido neste ponto, esta rejeição específica não gera
      // registro em Averbacao/Recusados, no mesmo padrão já documentado para tenant não
      // encontrado/XML inválido/token de recuperação inválido (ver persistErro acima).
      return this.erro('ERR-4016');
    }

    // 4b. Gravação Bruta do XML (Criptografado / Hash SHA-256) - ISO 27001 / LGPD. Feito aqui
    // (antes das checagens que podem rejeitar o documento) porque ERR-4007/4008/4002/4003 já
    // conhecem o policy_id e passam a gerar um registro de Averbacao com status='ERRO', que
    // exige um raw_xml_id — precisamos do XML bruto salvo mesmo quando o documento é rejeitado.
    const hashSHA256 = crypto.createHash('sha256').update(contentToParse).digest('hex');
    const rawXmlRecord: RawXMLStore = {
      id: uuidv4(),
      content_xml: contentToParse,
      hash_sha256: hashSHA256,
      encrypted_aes256: true,
      created_at: new Date().toISOString()
    };
    dbStore.rawXmlStore.push(rawXmlRecord);

    // 4c. Carrega o blob de Regras de Negócio da apólice cedo — Fase 4 do pacote de 21/09 precisa
    // dele já na checagem de titularidade (passo 5), para saber se a "fila genérica" (Bloco 2 de
    // Tratamento de Recusas, regras:fila-aprovacao-recusas) está ligada. Antes só era carregado
    // no passo 9d (Prazos e Datas); mantido carregado uma única vez aqui, reaproveitado depois.
    const businessConfig = RuleEngineService.getBusinessConfig(policy);
    const filaGenericaHabilitada = businessConfig['regras:fila-aprovacao-recusas'] === true;

    // 5. Checagem de Titularidade v2 — Regra A (função do CNPJ no documento) + Regra B (bypass por rota/produto)
    const regrasAplicadas: string[] = [];
    const tenantCnpjLimpo = tenant.cnpj.replace(/\D/g, '');
    // Aceita string ou number defensivamente — parsers de XML/JSON de terceiros podem
    // entregar um CNPJ puramente numérico como Number em vez de String.
    const norm = (v?: string | number) => (v !== undefined && v !== null ? String(v).replace(/\D/g, '') : undefined);

    const isEmitente = norm(parsedDoc.cnpjEmitente) === tenantCnpjLimpo;

    const funcaoParaCnpj: Record<string, string | undefined> = {
      DESTINATARIO: norm(parsedDoc.cnpjDestinatario),
      REMETENTE: norm(parsedDoc.cnpjRemetente),
      TOMADOR: norm(parsedDoc.cnpjTomador),
      EXPEDIDOR: norm(parsedDoc.cnpjExpedidor),
      RECEBEDOR: norm(parsedDoc.cnpjRecebedor),
      TRANSPORTADOR: norm(parsedDoc.cnpjTransportador)
    };

    const titularityRules = dbStore.policyTitularityRules.filter((r) => r.policy_id === policy.id);

    let matchedByFuncao = false;
    if (!isEmitente) {
      if (titularityRules.length > 0) {
        matchedByFuncao = titularityRules.some(
          (r) => r.habilitada && funcaoParaCnpj[r.funcao] === tenantCnpjLimpo
        );
      } else {
        // Sem regras cadastradas: cai no comportamento legado (só Destinatário, via flag antiga)
        matchedByFuncao = Boolean(policy.aceita_averbacao_como_destinatario) && funcaoParaCnpj.DESTINATARIO === tenantCnpjLimpo;
      }
    }

    let matchedByBypass = false;
    if (!isEmitente && !matchedByFuncao) {
      const bypassRules = dbStore.policyBypassRules.filter((r) => r.policy_id === policy.id);
      matchedByBypass = bypassRules.some((r) => {
        const rotaOk =
          (!r.rota_uf_origem || r.rota_uf_origem === parsedDoc.ufOrigem) &&
          (!r.rota_uf_destino || r.rota_uf_destino === parsedDoc.ufDestino);
        const produtoOk = !r.produto_predominante || r.produto_predominante === parsedDoc.produtoPredominante;
        return rotaOk && produtoOk;
      });
    }

    if (!isEmitente && !matchedByFuncao && !matchedByBypass) {
      const fmt = ResponseEngine.formatResponse('ERR-4008');
      // Fase 4 — Bloco 2 de Tratamento de Recusas ("fila genérica"): quando ligado na apólice,
      // motivos de recusa que não sejam LMI/sublimite (que têm sua própria estratégia no Bloco 1)
      // viram pendência em vez de recusa definitiva. Desligado por padrão — preserva o
      // comportamento anterior para quem nunca configurou essa aba.
      if (filaGenericaHabilitada) {
        const registro = this.persistPendente(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
        return { status: 'pendente', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao_id: registro.id };
      }
      this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
      return this.erro('ERR-4008');
    }

    if (matchedByFuncao) {
      const funcaoUsada = Object.entries(funcaoParaCnpj).find(([, v]) => v === tenantCnpjLimpo)?.[0];
      if (funcaoUsada) regrasAplicadas.push(`Titularidade aceita via função '${funcaoUsada}' do documento.`);
    } else if (matchedByBypass) {
      regrasAplicadas.push('Titularidade aceita via bypass (Regra B — rota/produto), sem CNPJ presente no documento.');
    }

    // 6. Checagem de Deduplicação — (chave_documento, protocolo_aceitacao_sefaz, ramo) já averbados?
    const jaAverbado = dbStore.averbacoes.find(
      (a) =>
        a.chave_documento === parsedDoc.chaveDocumento &&
        a.protocolo_aceitacao_sefaz === parsedDoc.protocoloAceitacaoSefaz &&
        a.policy_id === policy.id &&
        a.status === 'SUCESSO'
    );
    if (jaAverbado) {
      const fmt = ResponseEngine.formatResponse('ERR-4007', {
        // status === 'SUCESSO' garante numero_averbacao preenchido; o '' é só para satisfazer o
        // tipo (agora opcional, já que registros status='ERRO' não têm número).
        NUMERO_AVERBACAO_EXISTENTE: jaAverbado.numero_averbacao ?? ''
      });
      this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
      return this.erro('ERR-4007', {
        // status === 'SUCESSO' garante numero_averbacao preenchido; o '' é só para satisfazer o
        // tipo (agora opcional, já que registros status='ERRO' não têm número).
        NUMERO_AVERBACAO_EXISTENTE: jaAverbado.numero_averbacao ?? ''
      });
    }

    // 7. Validação de Inatividade / Apólice Vencida com Flag de Exceção
    //
    // Antes, "apólice vencida" só era detectado via policy.status !== 'ATIVA' — um campo MANUAL.
    // Se ninguém trocasse esse campo à mão quando a vigência realmente expirava, o sistema
    // aceitava a averbação normalmente mesmo com a data de vigência já passada. Agora a data de
    // vigência (vigencia_fim) também é checada automaticamente, sem depender de ninguém lembrar
    // de atualizar o status — mas continua respeitando o mesmo bypass (permitir_inativo_vencido)
    // já usado pra apólice vencida/cadastro inativo, já que é exatamente o caso que esse flag
    // sempre disse cobrir.
    const isTenantInactive = tenant.status === 'INATIVO';
    const isPolicyStatusInactive = policy.status !== 'ATIVA';
    const isPolicyExpiredByDate = Boolean(policy.vigencia_fim) && new Date(policy.vigencia_fim).getTime() < Date.now();
    // Fase 2 do pacote de 21/09 (Suspensão de Apólice) — "está suspensa agora" é sempre
    // calculado a partir das duas datas, nunca lido de um boolean solto (ver comentário em
    // Policy.suspensa_desde em types/index.ts): evita ficar suspensa para sempre depois que o
    // prazo determinado já passou.
    const isPolicySuspensa =
      Boolean(policy.suspensa_desde) &&
      new Date(policy.suspensa_desde!).getTime() <= Date.now() &&
      (!policy.suspensa_ate || new Date(policy.suspensa_ate).getTime() >= Date.now());
    const isInactiveProblem = isTenantInactive || isPolicyStatusInactive || isPolicyExpiredByDate || isPolicySuspensa;

    let hasWarningBypass = false;

    if (isInactiveProblem) {
      if (policy.permitir_inativo_vencido) {
        hasWarningBypass = true;
        regrasAplicadas.push('Bypass de apólice vencida/cadastro inativo/suspensa aplicado (exceção configurada na apólice).');
      } else {
        // ERR-4002/ERR-4003 continuam recusa definitiva (cadastro/apólice inativos são um estado
        // administrativo, não uma pendência a resolver por decisão pontual). ERR-4011 (vigência
        // vencida) e ERR-4017 (nova — apólice suspensa) viram PENDENTE_APROVACAO — Fase 4 do
        // pacote de 21/09 (documentos-pendentes-campos-api.md pede exatamente esses dois como
        // cenários de "Documentos Pendentes", não recusa definitiva).
        const errCode = isTenantInactive
          ? 'ERR-4002'
          : isPolicyStatusInactive
            ? 'ERR-4003'
            : isPolicySuspensa
              ? 'ERR-4017'
              : 'ERR-4011';
        const fmt =
          errCode === 'ERR-4011'
            ? ResponseEngine.formatResponse(errCode, { VIGENCIA_FIM: policy.vigencia_fim })
            : errCode === 'ERR-4017'
              ? ResponseEngine.formatResponse(errCode, { SUSPENSA_ATE: policy.suspensa_ate ?? 'prazo indeterminado' })
              : ResponseEngine.formatResponse(errCode);

        if (errCode === 'ERR-4011' || errCode === 'ERR-4017') {
          const registro = this.persistPendente(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
          return { status: 'pendente', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao_id: registro.id };
        }
        this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
        return this.erro(errCode);
      }
    }

    // 8. Validação do Motor de Regras (tags do documento + coberturas adicionais + variáveis de apólice)
    const ruleResult = RuleEngineService.validate(policy, parsedDoc, dto.supplemented_vars || {});

    if (!ruleResult.valid) {
      const missingVarName = ruleResult.missingVariables.join(', ');
      const recToken = `rec_${uuidv4().replace(/-/g, '')}`;

      const newRecoverySession: RecoverySession = {
        token: recToken,
        tenant_id: tenant.id,
        policy_id: policy.id,
        tipo_documento: parsedDoc.tipoDocumento,
        raw_xml_content: contentToParse,
        variaveis_faltantes: ruleResult.missingVariables,
        expira_em: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        utilizada: false,
        created_at: new Date().toISOString()
      };
      dbStore.recoverySessions.push(newRecoverySession);
      dbStore.persist();

      return this.erro(
        'ERR-4004',
        { NOME_VARIAVEL: missingVarName },
        {
          variaveis_faltantes: ruleResult.missingVariables,
          recuperacao: {
            token_recuperacao: recToken,
            url_preenchimento: `${appBaseUrl}/recuperar/${recToken}`,
            instrucao:
              'O cliente pode preencher a variável pelo link acima, reenviar a requisição suplementando o campo, ou corrigir diretamente dentro do próprio Portal do Transportador.'
          }
        }
      );
    }

    // Se veio de uma sessão de recuperação válida, marcar como utilizada
    if (recoverySession) {
      recoverySession.utilizada = true;
    }

    // 9. Somar Coberturas Adicionais Monetárias ao Valor Final da Averbação
    const { total: totalCoberturas, aplicadas: coberturasAplicadas } = RuleEngineService.sumMonetaryCoverages(
      policy,
      parsedDoc,
      dto.supplemented_vars || {}
    );
    let valorConsiderado = parsedDoc.valorCarga + totalCoberturas;
    for (const c of coberturasAplicadas) {
      regrasAplicadas.push(`Cobertura adicional '${c.titulo}' localizada e somada (R$ ${c.valor.toFixed(2)}).`);
    }

    // 9b. Checagem de LMI (Limite Máximo de Garantia) — antes, policy.lmi era gravado e editável
    // pela seguradora nas telas de cadastro/edição de apólice, mas nunca era comparado com o
    // valor da averbação em nenhum lugar do fluxo: dava pra averbar um valor acima do limite
    // contratado sem nenhum aviso. Só aplica quando a apólice tem um LMI configurado (campo
    // opcional) — sem LMI cadastrado, não há limite a enforçar.
    //
    // Fase 4 do pacote de 21/09 (Tratamento de Recusas, Bloco 1) — o excedente não é mais sempre
    // uma recusa definitiva: passa por `avaliarLimiteComEstrategia`, que decide entre aprovar
    // (com ou sem truncar), enfileirar como pendência, ou recusar, conforme a estratégia
    // configurada na apólice (padrão 'exigir-codigo', igual ao descrito no relatório).
    const lmiSnapshot = policy.lmi;
    if (policy.lmi !== undefined && valorConsiderado > policy.lmi) {
      const avaliacao = this.avaliarLimiteComEstrategia({
        valorConsiderado,
        limite: policy.lmi,
        tipoLimite: 'LMI',
        businessConfig,
        policy,
        codigoLiberacaoInformado: dto.codigo_liberacao
      });
      const replacements = { VALOR_AVERBACAO: valorConsiderado.toFixed(2), LMI_APOLICE: policy.lmi.toFixed(2) };

      if (avaliacao.resultado === 'aprovado') {
        valorConsiderado = avaliacao.valorFinal;
        if (avaliacao.codigoConsumido) {
          regrasAplicadas.push(`Código de liberação '${avaliacao.codigoConsumido}' aplicado para o excedente do LMI.`);
        } else if (avaliacao.valorFinal < parsedDoc.valorCarga + totalCoberturas) {
          regrasAplicadas.push(`Valor truncado no LMI da apólice (R$ ${policy.lmi.toFixed(2)}), conforme estratégia configurada.`);
        } else {
          regrasAplicadas.push('Excedente do LMI aceito sem trava, conforme estratégia configurada na apólice.');
        }
      } else if (avaliacao.resultado === 'pendente') {
        const fmt = ResponseEngine.formatResponse('ERR-4010', replacements);
        const registro = this.persistPendente(
          tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas, valorConsiderado, lmiSnapshot
        );
        return { status: 'pendente', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao_id: registro.id };
      } else {
        const fmt = ResponseEngine.formatResponse('ERR-4010', replacements);
        this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
        return this.erro('ERR-4010', replacements);
      }
    }

    // 9c. Sublimites (aba "Sublimites" da Ficha do Segurado) — achado da auditoria de 28/08: acima
    // do LMI da apólice inteira, a seguradora pode cadastrar um teto menor para uma condição mais
    // específica, mas isso nunca era comparado com o valor da averbação aqui. Ampliado em 05/09
    // (item D-10 do relatório técnico do wizard de cadastro, compartilhado pelo usuário): a
    // seguradora agora pode cadastrar um sublimite por mercadoria (como antes), por CNPJ do
    // tomador, ou pela combinação dos dois — quando mais de um bate com o mesmo documento, a
    // condição mais específica prevalece: tomador_mercadoria > tomador > mercadoria. A
    // comparação de mercadoria continua exigindo correspondência EXATA da palavra-chave (sem
    // distinguir maiúsculas/acentos) com o produto predominante do documento (proPred, hoje só
    // extraído de CT-e) — não por substring, para não recusar uma averbação por coincidência de
    // texto livre. `tipo_condicao` ausente (sublimites cadastrados antes do D-10) é tratado como
    // 'mercadoria', preservando o comportamento anterior.
    const normalizeProduto = (v: string) =>
      v
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase();
    const produtoNormalizado = parsedDoc.produtoPredominante
      ? normalizeProduto(parsedDoc.produtoPredominante)
      : undefined;
    const cnpjTomadorDoc = norm(parsedDoc.cnpjTomador);

    const PRIORIDADE_TIPO_CONDICAO: Record<string, number> = {
      tomador_mercadoria: 3,
      tomador: 2,
      mercadoria: 1
    };

    const sublimitesCandidatos = dbStore.policySublimites.filter((s) => {
      if (s.policy_id !== policy.id) return false;
      const tipo = s.tipo_condicao ?? 'mercadoria';
      const mercadoriaBate =
        produtoNormalizado !== undefined && s.tag !== undefined && normalizeProduto(s.tag) === produtoNormalizado;
      const tomadorBate = cnpjTomadorDoc !== undefined && norm(s.cnpj_tomador) === cnpjTomadorDoc;

      if (tipo === 'mercadoria') return mercadoriaBate;
      if (tipo === 'tomador') return tomadorBate;
      return mercadoriaBate && tomadorBate; // tomador_mercadoria — os dois precisam bater
    });

    const sublimite = sublimitesCandidatos.sort(
      (a, b) =>
        PRIORIDADE_TIPO_CONDICAO[b.tipo_condicao ?? 'mercadoria'] -
        PRIORIDADE_TIPO_CONDICAO[a.tipo_condicao ?? 'mercadoria']
    )[0];

    let sublimiteSnapshot: number | undefined;
    if (sublimite) {
      const valorSublimite = RuleEngineService.parseMoneyBR(sublimite.valor);
      sublimiteSnapshot = isNaN(valorSublimite) ? undefined : valorSublimite;
      if (!isNaN(valorSublimite) && valorConsiderado > valorSublimite) {
        const tipoSublimite = sublimite.tipo_condicao ?? 'mercadoria';
        const descricaoCondicao =
          tipoSublimite === 'tomador'
            ? `tomador ${sublimite.cnpj_tomador}`
            : tipoSublimite === 'tomador_mercadoria'
              ? `tomador ${sublimite.cnpj_tomador} + mercadoria '${sublimite.tag}'`
              : `mercadoria '${sublimite.tag}'`;
        const replacements = {
          VALOR_AVERBACAO: valorConsiderado.toFixed(2),
          MERCADORIA: descricaoCondicao,
          SUBLIMITE: valorSublimite.toFixed(2)
        };

        // Mesma estratégia do LMI (Bloco 1), mas sublimite nunca consome codigo_liberacao — ver
        // comentário em avaliarLimiteComEstrategia.
        const avaliacao = this.avaliarLimiteComEstrategia({
          valorConsiderado,
          limite: valorSublimite,
          tipoLimite: 'SUBLIMITE',
          businessConfig,
          policy
        });

        if (avaliacao.resultado === 'aprovado') {
          valorConsiderado = avaliacao.valorFinal;
          regrasAplicadas.push(
            valorConsiderado < parsedDoc.valorCarga + totalCoberturas
              ? `Valor truncado no sublimite (${descricaoCondicao}, R$ ${valorSublimite.toFixed(2)}), conforme estratégia configurada.`
              : `Excedente do sublimite (${descricaoCondicao}) aceito sem trava, conforme estratégia configurada na apólice.`
          );
        } else if (avaliacao.resultado === 'pendente') {
          const fmt = ResponseEngine.formatResponse('ERR-4013', replacements);
          const registro = this.persistPendente(
            tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas, valorConsiderado, lmiSnapshot, sublimiteSnapshot
          );
          return { status: 'pendente', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao_id: registro.id };
        } else {
          const fmt = ResponseEngine.formatResponse('ERR-4013', replacements);
          this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
          return this.erro('ERR-4013', replacements);
        }
      }
    }

    // 9d. Prazos e Datas (aba Regras de Negócio da Ficha do Segurado) — Bloco "Prazo de Emissão" e
    // "Regra de Prazo de Embarque". Achado da auditoria de 28/08: também salvos e exibidos, nunca
    // checados. Só aplicados quando a seguradora salvou explicitamente essa configuração NESTA
    // apólice (ver comentário de getBusinessConfig em ruleEngine.ts) — nenhuma apólice que nunca
    // abriu esta aba passa a ser bloqueada por um prazo "padrão" inventado por nós. O Bloco "Prazo
    // de Cancelamento" NÃO foi implementado nesta rodada — o sistema ainda não tem nenhum fluxo de
    // cancelamento de averbação para aplicar esse prazo contra (ver achado registrado no backlog).
    const prazoErro = this.checkPrazos(businessConfig, parsedDoc.tagsMap);
    if (prazoErro) {
      const fmt = ResponseEngine.formatResponse(prazoErro.codigo, prazoErro.replacements);
      if (filaGenericaHabilitada) {
        const registro = this.persistPendente(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
        return { status: 'pendente', codigo: fmt.codigo, mensagem: fmt.mensagem, averbacao_id: registro.id };
      }
      this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
      return this.erro(prazoErro.codigo, prazoErro.replacements);
    }

    // 10. Tratamento de Ambiente Sefaz (tpAmb) — homologação nunca tem validade jurídica real
    const isHomologacaoSefaz = parsedDoc.tpAmbSefaz === 2;
    if (isHomologacaoSefaz) {
      regrasAplicadas.push(
        'Documento identificado como emitido no ambiente de HOMOLOGAÇÃO do Sefaz (tpAmb=2) — averbação processada apenas para fins de teste, sem validade jurídica.'
      );
    }

    // 12. Gerar Número de Averbação (formato de mercado) + Protocolo Interno (nosso, independente)
    const timestampISO = new Date().toISOString();
    const testePrefix = isHomologacaoSefaz ? 'TESTE-' : '';
    const numeroAverbacao = `${testePrefix}AVB-${dto.ramo}-${Date.now().toString().slice(-6)}-${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;
    const protocoloInterno = `PI-${uuidv4()}`;

    // 13. Registrar Averbação
    const codigoSucesso = hasWarningBypass ? 'SUC-2001' : 'SUC-2000';
    const resFormat = ResponseEngine.formatResponse(codigoSucesso, {
      NUMERO_AVERBACAO: numeroAverbacao,
      TIMESTAMP: timestampISO
    });

    const averbacaoRecord: Averbacao = {
      id: uuidv4(),
      numero_averbacao: numeroAverbacao,
      protocolo_interno_averbacao: protocoloInterno,
      tenant_id: tenant.id,
      policy_id: policy.id,
      status: 'SUCESSO',
      codigo_resposta: resFormat.codigo,
      mensagem_resposta: resFormat.mensagem,
      valor_carga: parsedDoc.valorCarga,
      valor_considerado_averbacao: valorConsiderado,
      lmi_no_momento_envio: lmiSnapshot,
      sublimite_no_momento_envio: sublimiteSnapshot,
      codigo_liberacao_utilizado: dto.codigo_liberacao,
      regras_internas_aplicadas: regrasAplicadas,
      tp_amb_sefaz: parsedDoc.tpAmbSefaz,
      tipo_documento: parsedDoc.tipoDocumento,
      chave_documento: parsedDoc.chaveDocumento,
      numero_documento: parsedDoc.numeroDocumento,
      serie_documento: parsedDoc.serie,
      cnpj_emissor: parsedDoc.cnpjEmitente,
      cnpj_remetente: parsedDoc.cnpjRemetente,
      cnpj_destinatario: parsedDoc.cnpjDestinatario,
      cnpj_tomador: parsedDoc.cnpjTomador,
      protocolo_aceitacao_sefaz: parsedDoc.protocoloAceitacaoSefaz,
      raw_xml_id: rawXmlRecord.id,
      recovery_token: dto.recovery_token,
      ambiente: tenant.ambiente,
      timestamp: timestampISO,
      created_at: timestampISO
    };

    dbStore.averbacoes.unshift(averbacaoRecord);
    dbStore.persist();

    return {
      status: hasWarningBypass ? 'aviso' : 'sucesso',
      codigo: resFormat.codigo,
      mensagem: resFormat.mensagem,
      averbacao_id: averbacaoRecord.id,
      numero_averbacao: numeroAverbacao,
      protocolo_interno_averbacao: protocoloInterno,
      valor_considerado_averbacao: valorConsiderado,
      regras_internas_aplicadas: regrasAplicadas,
      timestamp: timestampISO,
      hash_validacao: hashSHA256
    };
  }

  /**
   * Fase 4 do pacote de 21/09 — reprocessa um documento PENDENTE_APROVACAO ou ERRO já existente,
   * a partir do XML já salvo (`RawXMLStore`), sem exigir novo upload. Usado por
   * `POST /tenant/averbacoes/:id/reenviar`. Cria um NOVO registro de Averbacao (o antigo
   * permanece intacto para histórico/auditoria) — mesmo padrão de "cada tentativa é um registro"
   * já usado no resto do motor. `supplementedVars` precisa ser reenviado por quem chama quando a
   * pendência original dependia de uma variável suplementada (ex.: recuperação) — esse valor não
   * fica gravado em nenhum lugar hoje, só o XML bruto.
   */
  public static reenviar(
    averbacaoAnterior: Averbacao,
    appBaseUrl: string,
    codigoLiberacao?: string,
    supplementedVars?: Record<string, any>
  ): AverbacaoResponseDTO {
    const rawXml = dbStore.rawXmlStore.find((r) => r.id === averbacaoAnterior.raw_xml_id);
    if (!rawXml) {
      return this.erro('ERR-4005', {}, {});
    }
    return this.process(
      {
        tenant_id: averbacaoAnterior.tenant_id,
        ramo: dbStore.policies.find((p) => p.id === averbacaoAnterior.policy_id)?.ramo ?? ('RCTRC' as RamoApolice),
        policy_id: averbacaoAnterior.policy_id,
        xml_content: rawXml.content_xml,
        codigo_liberacao: codigoLiberacao,
        supplemented_vars: supplementedVars
      },
      appBaseUrl
    );
  }
}
