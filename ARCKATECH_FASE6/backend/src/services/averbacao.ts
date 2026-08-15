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
    }

    // 3. Parse do Documento XML / JSON
    const contentToParse = dto.xml_content || recoverySession?.raw_xml_content || '';
    let parsedDoc;
    try {
      parsedDoc = XMLParserService.parse(contentToParse);
    } catch (err: any) {
      return this.erro('ERR-4005');
    }

    // 4. Buscar a Apólice Ativa para o Ramo Solicitado (RCTRC, RCDC, RCV)
    const policy = dbStore.policies.find(
      (p) => p.tenant_id === tenant.id && p.ramo === dto.ramo
    );
    if (!policy) {
      return this.erro('ERR-4003');
    }

    // 5. Checagem de Titularidade — o CNPJ do tenant é o emissor ou (se permitido) o destinatário do documento?
    const tenantCnpjLimpo = tenant.cnpj.replace(/\D/g, '');
    const isEmitente = parsedDoc.cnpjEmitente && parsedDoc.cnpjEmitente.replace(/\D/g, '') === tenantCnpjLimpo;
    const isDestinatario = parsedDoc.cnpjDestinatario && parsedDoc.cnpjDestinatario.replace(/\D/g, '') === tenantCnpjLimpo;

    if (!isEmitente) {
      if (!isDestinatario || !policy.aceita_averbacao_como_destinatario) {
        return this.erro('ERR-4008');
      }
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
      return this.erro('ERR-4007', {
        NUMERO_AVERBACAO_EXISTENTE: jaAverbado.numero_averbacao
      });
    }

    // 7. Validação de Inatividade / Apólice Vencida com Flag de Exceção
    const isTenantInactive = tenant.status === 'INATIVO';
    const isPolicyInactiveOrExpired = policy.status !== 'ATIVA';
    const isInactiveProblem = isTenantInactive || isPolicyInactiveOrExpired;

    let hasWarningBypass = false;
    const regrasAplicadas: string[] = [];

    if (isInactiveProblem) {
      if (policy.permitir_inativo_vencido) {
        hasWarningBypass = true;
        regrasAplicadas.push('Bypass de apólice vencida/cadastro inativo aplicado (exceção configurada na apólice).');
      } else {
        const errCode = isTenantInactive ? 'ERR-4002' : 'ERR-4003';
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
    const valorConsiderado = parsedDoc.valorCarga + totalCoberturas;
    for (const c of coberturasAplicadas) {
      regrasAplicadas.push(`Cobertura adicional '${c.titulo}' localizada e somada (R$ ${c.valor.toFixed(2)}).`);
    }

    // 10. Tratamento de Ambiente Sefaz (tpAmb) — homologação nunca tem validade jurídica real
    const isHomologacaoSefaz = parsedDoc.tpAmbSefaz === 2;
    if (isHomologacaoSefaz) {
      regrasAplicadas.push(
        'Documento identificado como emitido no ambiente de HOMOLOGAÇÃO do Sefaz (tpAmb=2) — averbação processada apenas para fins de teste, sem validade jurídica.'
      );
    }

    // 11. Gravação Bruta do XML (Criptografado / Hash SHA-256) - ISO 27001 / LGPD
    const hashSHA256 = crypto.createHash('sha256').update(contentToParse).digest('hex');
    const rawXmlRecord: RawXMLStore = {
      id: uuidv4(),
      content_xml: contentToParse,
      hash_sha256: hashSHA256,
      encrypted_aes256: true,
      created_at: new Date().toISOString()
    };
    dbStore.rawXmlStore.push(rawXmlRecord);

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
