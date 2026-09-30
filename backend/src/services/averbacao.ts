import { now } from './clock';
import { randomBytes } from 'crypto';
import { normalizeAlphanumeric, normalizeCnpj } from '../utils/cnpj';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import { Tenant, Policy, RamoApolice, Averbacao, RecoverySession } from '../types';
import { XMLParserService } from './xmlParser';
import { RuleEngineService } from './ruleEngine';
import { ResponseEngine } from './responseEngine';
import { RawDocumentService } from './rawDocumentService';
import { efetivarInativacaoProgramadaSeNecessaria, sincronizarStatusCadastroSeNecessario } from './tenantLifecycle';
import { validatePolicyDocumentDate } from './policyValidity';
import { PolicyFinancialLimitsService } from './policyFinancialLimits';

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
  /** Raw XML já persistido pela camada de ingestão; evita duplicar o mesmo blob por canal/apólice. */
  raw_xml_id?: string;
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

  private static persistErro(
    tenant: Tenant,
    policy: Policy,
    parsedDoc: ReturnType<typeof XMLParserService.parse>,
    rawXmlId: string,
    fmt: { codigo: string; mensagem: string },
    regrasAplicadas: string[]
  ): void {
    const timestampISO = new Date(now()).toISOString();
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
    const timestampISO = new Date(now()).toISOString();
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
        new Date(codigo.validade).getTime() >= now() &&
        (codigo.usos_maximos === undefined || codigo.usos_realizados < codigo.usos_maximos) &&
        (codigo.valor_carga_liberado === undefined || codigo.valor_carga_liberado >= excedente);
      if (!codigoValido) {
        return { resultado: 'recusado', valorFinal: valorConsiderado };
      }
      codigo!.usos_realizados += 1;
      return { resultado: 'aprovado', valorFinal: valorConsiderado, codigoConsumido: codigo!.codigo };
    }
    const modo = businessConfig['regras:sem-codigo-modo'] ?? 'fila-sempre';
    if (modo === 'fila-sempre') {
      return { resultado: 'pendente', valorFinal: valorConsiderado };
    }
    const teto = Number(businessConfig['regras:teto-valor']);
    if (!isNaN(teto) && valorConsiderado <= teto) {
      return { resultado: 'aprovado', valorFinal: valorConsiderado };
    }
    const acaoAcimaTeto = businessConfig['regras:teto-acima-acao'] ?? 'fila';
    return { resultado: acaoAcimaTeto === 'recusar' ? 'recusado' : 'pendente', valorFinal: valorConsiderado };
  }

  private static parseDataEmbarqueBR(value: string): Date | undefined {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
    if (!m) return undefined;
    const [, d, mo, y] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(date.getTime()) ? undefined : date;
  }

  private static checkPrazos(
    businessConfig: Record<string, any>,
    tagsMap: Record<string, any>
  ): { codigo: string; replacements: Record<string, string> } | null {
    const dataEmbarqueRaw = tagsMap['DATA_EMBARQUE'];
    const dataEmbarque =
      typeof dataEmbarqueRaw === 'string' ? this.parseDataEmbarqueBR(dataEmbarqueRaw) : undefined;

    if (dataEmbarque) {
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

      if (now() > limite.getTime()) {
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

    if (!('regras:prazo-valor' in businessConfig)) return null;

    const campoBase = businessConfig['regras:prazo-campo'] === 'dhRecBto' ? 'dhRecBto' : 'dhEmi';
    const dataBaseRaw = tagsMap[campoBase];
    if (!dataBaseRaw) return null;

    const dataBase = new Date(dataBaseRaw);
    if (isNaN(dataBase.getTime())) return null;

    const prazoValor = Number(businessConfig['regras:prazo-valor']);
    if (isNaN(prazoValor) || prazoValor <= 0) return null;

    const unidadeMs = businessConfig['regras:prazo-unidade'] === 'Horas' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const limite = new Date(dataBase.getTime() + prazoValor * unidadeMs);

    if (now() > limite.getTime()) {
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

  public static process(dto: AverbacaoRequestDTO, appBaseUrl: string = 'http://localhost:5173'): AverbacaoResponseDTO {
    const tenant = dbStore.tenants.find((t) => t.id === dto.tenant_id);
    if (!tenant) {
      return this.erro('ERR-4001');
    }
    efetivarInativacaoProgramadaSeNecessaria(tenant);
    sincronizarStatusCadastroSeNecessario(tenant, dbStore.policies.filter((p) => p.tenant_id === tenant.id));

    let recoverySession: RecoverySession | undefined;
    if (dto.recovery_token) {
      recoverySession = dbStore.recoverySessions.find(
        (r) => r.token === dto.recovery_token && !r.utilizada
      );
      if (!recoverySession) {
        return this.erro('ERR-4006');
      }
      if (new Date(recoverySession.expira_em).getTime() <= now()) {
        return this.erro('ERR-4012', { EXPIRA_EM: recoverySession.expira_em });
      }
    }

    const contentToParse = dto.xml_content || recoverySession?.raw_xml_content || '';
    let parsedDoc;
    try {
      parsedDoc = XMLParserService.parse(contentToParse);
    } catch (err: any) {
      return this.erro('ERR-4005');
    }

    const documentDate = parsedDoc.dataEmissao || parsedDoc.tagsMap['dhEmi'];
    let policy: Policy | undefined;

    if (dto.policy_id) {
      policy = dbStore.policies.find((p) => p.id === dto.policy_id && p.tenant_id === tenant.id);
    } else {
      const policiesDoRamo = dbStore.policies.filter(
        (p) => p.tenant_id === tenant.id && p.ramo === dto.ramo
      );

      if (!documentDate && policiesDoRamo.length > 1) {
        const fmt = ResponseEngine.formatResponse('ERR-4022');
        return {
          status: 'pendente',
          codigo: fmt.codigo,
          mensagem: fmt.mensagem,
          explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
          orientacao_correcao: fmt.orientacao_correcao
        };
      }

      if (documentDate) {
        const policiesNaVigencia = policiesDoRamo.filter(
          (candidate) => validatePolicyDocumentDate(candidate, documentDate).valid
        );

        if (policiesNaVigencia.length === 1) {
          policy = policiesNaVigencia[0];
        } else if (policiesNaVigencia.length > 1) {
          const fmt = ResponseEngine.formatResponse('ERR-4023', {
            DATA_DOCUMENTO: documentDate,
            QTD_APOLICES: String(policiesNaVigencia.length)
          });
          return {
            status: 'pendente',
            codigo: fmt.codigo,
            mensagem: fmt.mensagem,
            explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
            orientacao_correcao: fmt.orientacao_correcao
          };
        } else if (policiesDoRamo.length === 1) {
          policy = policiesDoRamo[0];
        } else if (policiesDoRamo.length > 1) {
          const fmt = ResponseEngine.formatResponse('ERR-4024', {
            DATA_DOCUMENTO: documentDate
          });
          return {
            status: 'pendente',
            codigo: fmt.codigo,
            mensagem: fmt.mensagem,
            explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
            orientacao_correcao: fmt.orientacao_correcao
          };
        }
      } else {
        policy = policiesDoRamo[0];
      }
    }

    if (!policy) {
      return this.erro('ERR-4016');
    }

    const rawXmlRecord =
      RawDocumentService.get(dto.raw_xml_id) ?? RawDocumentService.store(contentToParse, tenant.id);

    const businessConfig = RuleEngineService.getBusinessConfig(policy);
    const filaGenericaHabilitada = businessConfig['regras:fila-aprovacao-recusas'] === true;

    const regrasAplicadas: string[] = [];
    const policyDateValidity = validatePolicyDocumentDate(policy, documentDate);

    if (policyDateValidity.reason === 'DOCUMENT_DATE_MISSING') {
      const fmt = ResponseEngine.formatResponse('ERR-4022');
      regrasAplicadas.push('Vigência documental não avaliada: data de emissão ausente ou inválida.');
      const registro = this.persistPendente(
        tenant,
        policy,
        parsedDoc,
        rawXmlRecord.id,
        fmt,
        regrasAplicadas
      );
      return {
        status: 'pendente',
        codigo: fmt.codigo,
        mensagem: fmt.mensagem,
        averbacao_id: registro.id,
        explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
        orientacao_correcao: fmt.orientacao_correcao
      };
    }

    if (policyDateValidity.reason === 'BEFORE_POLICY_START') {
      const fmt = ResponseEngine.formatResponse('ERR-4021', {
        DATA_DOCUMENTO: documentDate ?? '',
        VIGENCIA_INICIO: policy.vigencia_inicio
      });
      regrasAplicadas.push(
        `Vigência documental: emissão ${documentDate} anterior ao início da apólice ${policy.vigencia_inicio}; encaminhada para análise de exceção.`
      );
      const registro = this.persistPendente(
        tenant,
        policy,
        parsedDoc,
        rawXmlRecord.id,
        fmt,
        regrasAplicadas
      );
      return {
        status: 'pendente',
        codigo: fmt.codigo,
        mensagem: fmt.mensagem,
        averbacao_id: registro.id,
        explicacao_nao_tecnica: fmt.explicacao_nao_tecnica,
        orientacao_correcao: fmt.orientacao_correcao
      };
    }

    const tenantCnpjLimpo = normalizeCnpj(tenant.cnpj);
    const norm = (v?: string | number) =>
      v !== undefined && v !== null ? normalizeCnpj(v) : undefined;

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

    const jaAverbado = dbStore.averbacoes.find(
      (a) =>
        normalizeAlphanumeric(a.chave_documento) === normalizeAlphanumeric(parsedDoc.chaveDocumento) &&
        a.protocolo_aceitacao_sefaz === parsedDoc.protocoloAceitacaoSefaz &&
        a.policy_id === policy.id &&
        a.status === 'SUCESSO'
    );
    if (jaAverbado) {
      const fmt = ResponseEngine.formatResponse('ERR-4007', {
        NUMERO_AVERBACAO_EXISTENTE: jaAverbado.numero_averbacao ?? ''
      });
      this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
      return this.erro('ERR-4007', {
        NUMERO_AVERBACAO_EXISTENTE: jaAverbado.numero_averbacao ?? ''
      });
    }

    const isTenantInactive = tenant.status === 'INATIVO';
    const isPolicyStatusInactive = policy.status !== 'ATIVA';
    const isPolicyExpiredByDate = policyDateValidity.reason === 'AFTER_POLICY_END';
    const isPolicySuspensa =
      Boolean(policy.suspensa_desde) &&
      new Date(policy.suspensa_desde!).getTime() <= now() &&
      (!policy.suspensa_ate || new Date(policy.suspensa_ate).getTime() >= now());
    const isInactiveProblem = isTenantInactive || isPolicyStatusInactive || isPolicyExpiredByDate || isPolicySuspensa;

    let hasWarningBypass = false;

    if (isInactiveProblem) {
      if (policy.permitir_inativo_vencido) {
        hasWarningBypass = true;
        regrasAplicadas.push('Bypass de apólice vencida/cadastro inativo/suspensa aplicado (exceção configurada na apólice).');
      } else {
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
        expira_em: new Date(now() + 24 * 60 * 60 * 1000).toISOString(),
        utilizada: false,
        created_at: new Date(now()).toISOString()
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

    if (recoverySession) {
      recoverySession.utilizada = true;
    }

    const { total: totalCoberturas, aplicadas: coberturasAplicadas } = RuleEngineService.sumMonetaryCoverages(
      policy,
      parsedDoc,
      dto.supplemented_vars || {}
    );
    let valorConsiderado = parsedDoc.valorCarga + totalCoberturas;
    for (const c of coberturasAplicadas) {
      regrasAplicadas.push(`Cobertura adicional '${c.titulo}' localizada e somada (R$ ${c.valor.toFixed(2)}).`);
    }

    // LMI contratual permanece imutável. Coberturas adicionais marcadas como `desconta_lmi`
    // reservam parte desse limite e reduzem apenas o LMI disponível para a nova averbação.
    const lmiSnapshot = policy.lmi;
    const lmiAvailability = PolicyFinancialLimitsService.calculateLmiAvailability(policy);
    const lmiDisponivel = lmiAvailability.available_lmi;
    if (lmiAvailability.reserved_lmi > 0 && lmiSnapshot !== undefined) {
      const detalhes = lmiAvailability.reservations
        .map((item) => `${item.titulo}: R$ ${item.valor.toFixed(2)}`)
        .join('; ');
      regrasAplicadas.push(
        `LMI contratual R$ ${lmiSnapshot.toFixed(2)}; reservas de coberturas adicionais R$ ${lmiAvailability.reserved_lmi.toFixed(2)} (${detalhes}); LMI disponível R$ ${(lmiDisponivel ?? 0).toFixed(2)}.`
      );
    }

    if (lmiDisponivel !== undefined && valorConsiderado > lmiDisponivel) {
      const avaliacao = this.avaliarLimiteComEstrategia({
        valorConsiderado,
        limite: lmiDisponivel,
        tipoLimite: 'LMI',
        businessConfig,
        policy,
        codigoLiberacaoInformado: dto.codigo_liberacao
      });
      const replacements = {
        VALOR_AVERBACAO: valorConsiderado.toFixed(2),
        LMI_APOLICE: lmiDisponivel.toFixed(2)
      };

      if (avaliacao.resultado === 'aprovado') {
        valorConsiderado = avaliacao.valorFinal;
        if (avaliacao.codigoConsumido) {
          regrasAplicadas.push(`Código de liberação '${avaliacao.codigoConsumido}' aplicado para o excedente do LMI disponível.`);
        } else if (avaliacao.valorFinal < parsedDoc.valorCarga + totalCoberturas) {
          regrasAplicadas.push(`Valor truncado no LMI disponível da apólice (R$ ${lmiDisponivel.toFixed(2)}), conforme estratégia configurada.`);
        } else {
          regrasAplicadas.push('Excedente do LMI disponível aceito sem trava, conforme estratégia configurada na apólice.');
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
      return mercadoriaBate && tomadorBate;
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

    const isHomologacaoSefaz = parsedDoc.tpAmbSefaz === 2;
    if (isHomologacaoSefaz) {
      regrasAplicadas.push(
        'Documento identificado como emitido no ambiente de HOMOLOGAÇÃO do Sefaz (tpAmb=2) — averbação processada apenas para fins de teste, sem validade jurídica.'
      );
    }

    const timestampISO = new Date(now()).toISOString();
    const testePrefix = isHomologacaoSefaz ? 'TESTE-' : '';
    const numeroAverbacao = `${testePrefix}AVB-${dto.ramo}-${now().toString().slice(-6)}-${randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;
    const protocoloInterno = `PI-${uuidv4()}`;

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
      hash_validacao: rawXmlRecord.hash_sha256
    };
  }

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

    const policyAnterior = dbStore.policies.find((p) => p.id === averbacaoAnterior.policy_id);
    const motivoAnterior = averbacaoAnterior.motivo_pendencia ?? averbacaoAnterior.codigo_resposta;
    const rematchearPorVigencia = motivoAnterior === 'ERR-4021';

    return this.process(
      {
        tenant_id: averbacaoAnterior.tenant_id,
        ramo: policyAnterior?.ramo ?? ('RCTRC' as RamoApolice),
        ...(rematchearPorVigencia ? {} : { policy_id: averbacaoAnterior.policy_id }),
        xml_content: rawXml.content_xml,
        codigo_liberacao: codigoLiberacao,
        supplemented_vars: supplementedVars
      },
      appBaseUrl
    );
  }
}
