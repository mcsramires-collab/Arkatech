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
  xml_content: string;
  recovery_token?: string;
  supplemented_vars?: Record<string, any>;
}

export interface AverbacaoResponseDTO {
  status: 'sucesso' | 'erro' | 'aviso';
  codigo: string;
  mensagem: string;
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

    // 4. Buscar a Apólice para o Ramo Solicitado (RCTRC, RCDC, RCV)
    //
    // Bug corrigido em 29/08: antes, .find() retornava a PRIMEIRA apólice que batesse
    // tenant_id + ramo, sem considerar status/vigência. Se o tenant tivesse mais de uma apólice
    // para o mesmo ramo (ex: uma antiga vencida/inativa e uma nova ativa), o motor podia acabar
    // pegando a errada mesmo havendo uma apólice ativa de verdade disponível — e o passo 7 abaixo
    // então recusava por "apólice inativa" (ERR-4003) apesar de existir apólice ativa. Agora
    // damos preferência explícita a uma apólice ATIVA e dentro da vigência quando houver mais de
    // uma opção para o mesmo ramo; só caímos numa apólice inativa/vencida se não houver nenhuma
    // ativa — nesse caso os passos 7+ seguem dando o motivo específico (ERR-4002/4003/4011).
    const policiesDoRamo = dbStore.policies.filter(
      (p) => p.tenant_id === tenant.id && p.ramo === dto.ramo
    );
    const isPolicyUsavel = (p: Policy) =>
      p.status === 'ATIVA' &&
      !(p.vigencia_fim && new Date(p.vigencia_fim).getTime() < Date.now());
    const policy = policiesDoRamo.find(isPolicyUsavel) || policiesDoRamo[0];

    if (!policy) {
      // Diferente de ERR-4003 (apólice ENCONTRADA mas com cadastro inativo, ver passo 7): aqui
      // não existe NENHUMA apólice cadastrada para este tenant+ramo. Código próprio para a
      // mensagem não confundir "apólice inativa" com "apólice não cadastrada para este ramo" —
      // achado da auditoria de 29/08 junto com o bug do .find() acima. Como não há policy_id
      // neste ponto, esta rejeição específica não gera registro em Averbacao/Recusados, no mesmo
      // padrão já documentado para tenant não encontrado/XML inválido/token de recuperação
      // inválido (ver persistErro acima).
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
      RECEBEDOR: norm(parsedDoc.cnpjRecebedor)
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
    const isInactiveProblem = isTenantInactive || isPolicyStatusInactive || isPolicyExpiredByDate;

    let hasWarningBypass = false;

    if (isInactiveProblem) {
      if (policy.permitir_inativo_vencido) {
        hasWarningBypass = true;
        regrasAplicadas.push('Bypass de apólice vencida/cadastro inativo aplicado (exceção configurada na apólice).');
      } else {
        // ERR-4011 é o caso novo: status ainda 'ATIVA' na apólice, mas a vigência já passou —
        // ERR-4002/ERR-4003 continuam cobrindo os dois motivos já existentes antes.
        const errCode = isTenantInactive ? 'ERR-4002' : isPolicyStatusInactive ? 'ERR-4003' : 'ERR-4011';
        const fmt =
          errCode === 'ERR-4011'
            ? ResponseEngine.formatResponse(errCode, { VIGENCIA_FIM: policy.vigencia_fim })
            : ResponseEngine.formatResponse(errCode);
        this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
        return errCode === 'ERR-4011'
          ? this.erro(errCode, { VIGENCIA_FIM: policy.vigencia_fim })
          : this.erro(errCode);
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
    const valorConsiderado = parsedDoc.valorCarga + totalCoberturas;
    for (const c of coberturasAplicadas) {
      regrasAplicadas.push(`Cobertura adicional '${c.titulo}' localizada e somada (R$ ${c.valor.toFixed(2)}).`);
    }

    // 9b. Checagem de LMI (Limite Máximo de Garantia) — antes, policy.lmi era gravado e editável
    // pela seguradora nas telas de cadastro/edição de apólice, mas nunca era comparado com o
    // valor da averbação em nenhum lugar do fluxo: dava pra averbar um valor acima do limite
    // contratado sem nenhum aviso. Só aplica quando a apólice tem um LMI configurado (campo
    // opcional) — sem LMI cadastrado, não há limite a enforçar.
    if (policy.lmi !== undefined && valorConsiderado > policy.lmi) {
      const fmt = ResponseEngine.formatResponse('ERR-4010', {
        VALOR_AVERBACAO: valorConsiderado.toFixed(2),
        LMI_APOLICE: policy.lmi.toFixed(2)
      });
      this.persistErro(tenant, policy, parsedDoc, rawXmlRecord.id, fmt, regrasAplicadas);
      return this.erro('ERR-4010', {
        VALOR_AVERBACAO: valorConsiderado.toFixed(2),
        LMI_APOLICE: policy.lmi.toFixed(2)
      });
    }

    // 9c. Sublimite por Mercadoria (aba "Sublimites por Mercadoria" da Ficha do Segurado) — achado
    // da auditoria de 28/08: acima do LMI da apólice inteira, a seguradora pode cadastrar um teto
    // menor para uma mercadoria específica, mas isso nunca era comparado com o valor da averbação
    // aqui. Só aplica quando o produto predominante do documento (proPred, hoje só extraído de
    // CT-e) bate EXATAMENTE (sem distinguir maiúsculas/acentos) com a palavra-chave cadastrada —
    // optamos por correspondência exata, não por substring, para não recusar uma averbação por
    // coincidência de texto livre; correspondência mais ampla (ex: por catálogo de produtos) fica
    // para uma iteração futura combinada com o produto.
    if (parsedDoc.produtoPredominante) {
      const normalizeProduto = (v: string) =>
        v
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .trim()
          .toLowerCase();
      const produtoNormalizado = normalizeProduto(parsedDoc.produtoPredominante);
      const sublimite = dbStore.policySublimites.find(
        (s) => s.policy_id === policy.id && normalizeProduto(s.tag) === produtoNormalizado
      );
      if (sublimite) {
        const valorSublimite = RuleEngineService.parseMoneyBR(sublimite.valor);
        if (!isNaN(valorSublimite) && valorConsiderado > valorSublimite) {
          const replacements = {
            VALOR_AVERBACAO: valorConsiderado.toFixed(2),
            MERCADORIA: sublimite.tag,
            SUBLIMITE: valorSublimite.toFixed(2)
          };
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
    const businessConfig = RuleEngineService.getBusinessConfig(policy);
    const prazoErro = this.checkPrazos(businessConfig, parsedDoc.tagsMap);
    if (prazoErro) {
      const fmt = ResponseEngine.formatResponse(prazoErro.codigo, prazoErro.replacements);
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
      regras_internas_aplicadas: regrasAplicadas,
      tp_amb_sefaz: parsedDoc.tpAmbSefaz,
      tipo_documento: parsedDoc.tipoDocumento,
      chave_documento: parsedDoc.chaveDocumento,
      numero_documento: parsedDoc.numeroDocumento,
      serie_documento: parsedDoc.serie,
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
      numero_averbacao: numeroAverbacao,
      protocolo_interno_averbacao: protocoloInterno,
      valor_considerado_averbacao: valorConsiderado,
      regras_internas_aplicadas: regrasAplicadas,
      timestamp: timestampISO,
      hash_validacao: hashSHA256
    };
  }
}
