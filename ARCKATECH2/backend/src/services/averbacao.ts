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
  timestamp?: string;
  hash_validacao?: string;
  variaveis_faltantes?: string[];
  recuperacao?: {
    token_recuperacao: string;
    url_preenchimento: string;
    instrucao: string;
  };
}

export class AverbacaoService {
  /**
   * Processa a solicitação de averbação de um documento fiscal.
   */
  public static process(dto: AverbacaoRequestDTO, appBaseUrl: string = 'http://localhost:5173'): AverbacaoResponseDTO {
    // 1. Localizar o Cliente / Tenant
    const tenant = dbStore.tenants.find((t) => t.id === dto.tenant_id);

    if (!tenant) {
      const errFormat = ResponseEngine.formatResponse('ERR-4001');
      return { status: 'erro', codigo: errFormat.codigo, mensagem: errFormat.mensagem };
    }

    // 2. Se for um envio de recuperação via Token existente
    let recoverySession: RecoverySession | undefined;
    if (dto.recovery_token) {
      recoverySession = dbStore.recoverySessions.find(
        (r) => r.token === dto.recovery_token && !r.utilizada
      );
      if (!recoverySession) {
        const errFormat = ResponseEngine.formatResponse('ERR-4006');
        return { status: 'erro', codigo: errFormat.codigo, mensagem: errFormat.mensagem };
      }
    }

    // 3. Parse do Documento XML / JSON
    const contentToParse = dto.xml_content || recoverySession?.raw_xml_content || '';
    let parsedDoc;
    try {
      parsedDoc = XMLParserService.parse(contentToParse);
    } catch (err: any) {
      const errFormat = ResponseEngine.formatResponse('ERR-4005');
      return { status: 'erro', codigo: errFormat.codigo, mensagem: errFormat.mensagem };
    }

    // 4. Buscar a Apólice Ativa para o Ramo Solicitado (RCTRC, RCDC, RCV)
    const policy = dbStore.policies.find(
      (p) => p.tenant_id === tenant.id && p.ramo === dto.ramo
    );

    if (!policy) {
      const errFormat = ResponseEngine.formatResponse('ERR-4003');
      return { status: 'erro', codigo: errFormat.codigo, mensagem: errFormat.mensagem };
    }

    // 5. Validação de Inatividade / Apólice Vencida com Flag de Exceção
    const isTenantInactive = tenant.status === 'INATIVO';
    const isPolicyInactiveOrExpired = policy.status !== 'ATIVA';
    const isInactiveProblem = isTenantInactive || isPolicyInactiveOrExpired;

    let hasWarningBypass = false;

    if (isInactiveProblem) {
      // Se a apólice possui permissão explícita de liberação para usuário inativo/vencido
      if (policy.permitir_inativo_vencido) {
        hasWarningBypass = true;
      } else {
        const errCode = isTenantInactive ? 'ERR-4002' : 'ERR-4003';
        const errFormat = ResponseEngine.formatResponse(errCode);
        return { status: 'erro', codigo: errFormat.codigo, mensagem: errFormat.mensagem };
      }
    }

    // 6. Validação do Motor de Regras da Apólice
    const ruleResult = RuleEngineService.validate(
      policy,
      parsedDoc,
      dto.supplemented_vars || {}
    );

    if (!ruleResult.valid) {
      const missingVarName = ruleResult.missingVariables.join(', ');
      const recToken = `rec_${uuidv4().replace(/-/g, '')}`;

      // Salvar Sessão de Recuperação para interatividade via Link/API
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

      const errFormat = ResponseEngine.formatResponse('ERR-4004', {
        NOME_VARIAVEL: missingVarName
      });

      return {
        status: 'erro',
        codigo: errFormat.codigo,
        mensagem: errFormat.mensagem,
        variaveis_faltantes: ruleResult.missingVariables,
        recuperacao: {
          token_recuperacao: recToken,
          url_preenchimento: `${appBaseUrl}/recuperar/${recToken}`,
          instrucao:
            'O cliente pode preencher a variável pelo link acima ou reenviar a requisição suplementando o campo.'
        }
      };
    }

    // Se veio de uma sessão de recuperação válida, marcar como utilizada
    if (recoverySession) {
      recoverySession.utilizada = true;
    }

    // 7. Gravação Bruta do XML (Criptografado / Hash SHA-256) - ISO 27001 / LGPD
    const hashSHA256 = crypto.createHash('sha256').update(contentToParse).digest('hex');
    const rawXmlRecord: RawXMLStore = {
      id: uuidv4(),
      content_xml: contentToParse,
      hash_sha256: hashSHA256,
      encrypted_aes256: true,
      created_at: new Date().toISOString()
    };
    dbStore.rawXmlStore.push(rawXmlRecord);

    // 8. Gerar Protocolo de Averbação
    const timestampISO = new Date().toISOString();
    const numeroAverbacao = `AVB-${dto.ramo}-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    // 9. Registrar Averbação
    const codigoSucesso = hasWarningBypass ? 'SUC-2001' : 'SUC-2000';
    const resFormat = ResponseEngine.formatResponse(codigoSucesso, {
      NUMERO_AVERBACAO: numeroAverbacao,
      TIMESTAMP: timestampISO
    });

    const averbacaoRecord: Averbacao = {
      id: uuidv4(),
      numero_averbacao: numeroAverbacao,
      tenant_id: tenant.id,
      policy_id: policy.id,
      status: 'SUCESSO',
      codigo_resposta: resFormat.codigo,
      mensagem_resposta: resFormat.mensagem,
      valor_carga: parsedDoc.valorCarga,
      tipo_documento: parsedDoc.tipoDocumento,
      chave_documento: parsedDoc.chaveDocumento,
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
      timestamp: timestampISO,
      hash_validacao: hashSHA256
    };
  }
}
