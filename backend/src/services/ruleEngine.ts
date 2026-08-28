import { dbStore } from './dbStore';
import { Policy } from '../types';
import { ParsedDocumentData } from './xmlParser';

export interface RuleValidationResult {
  valid: boolean;
  missingVariables: string[];
}

export class RuleEngineService {
  /**
   * Config de Regras de Negócio (PolicyBusinessSettings) salva pela seguradora para uma apólice,
   * na aba "Regras de Negócio" da Ficha do Segurado (Métodos de Averbação, Subcontratação,
   * Veículo e Motorista, Prazos e Datas, Região Metropolitana, Valor da Averbação, Averbação
   * Esporádica — ver arckatechseguradora/src/components/portal/regras-negocio.tsx). Uma chave só
   * existe aqui se a seguradora efetivamente alterou aquele campo — o valor-padrão exibido na
   * tela nunca é gravado sozinho (ver usePersistedState em wizard-context.tsx) — então checar
   * `'chave' in config` é a forma correta de saber se algo foi configurado de propósito, em vez
   * de assumir o padrão da tela para apólices que nunca abriram esta aba.
   */
  public static getBusinessConfig(policy: Policy): Record<string, any> {
    return dbStore.policyBusinessSettings.find((s) => s.policy_id === policy.id)?.config ?? {};
  }

  /** Converte string monetária BR ("R$ 25.000,00") em number. NaN se não for possível. */
  public static parseMoneyBR(value: string): number {
    return Number(
      String(value)
        .replace(/[^\d,.-]/g, '')
        .replace(/\.(?=\d{3},)/g, '')
        .replace(',', '.')
    );
  }

  /**
   * Avalia se o documento atende:
   *  1) as tags obrigatórias do PADRÃO SEFAZ para aquele TIPO DE DOCUMENTO
   *     (DocumentRule — vale para todos os documentos daquele tipo, independente da apólice)
   *  2) as coberturas adicionais obrigatórias configuradas pela SEGURADORA (InsurerCoverage —
   *     podem valer para todos os clientes dela ou só para este tenant específico)
   *  3) as variáveis de negócio obrigatórias definidas diretamente na APÓLICE (PolicyRule — legado)
   *  4) Veículo e Motorista / Data de Embarque, quando a seguradora ativou o toggle correspondente
   *     na aba Regras de Negócio (achado da auditoria de 28/08: esses três toggles eram salvos e
   *     exibidos na Ficha do Segurado, mas nunca chegavam a ser checados aqui). Tratadas como mais
   *     uma variável obrigatória, no mesmo padrão de PolicyRule/DocumentRule — usando a mesma
   *     convenção de variável em OBS (xObs/infCpl) já estabelecida nesta tela para TIPO_SEGURO e
   *     DATA_EMBARQUE (ver SintaxesAverbacao em regras-negocio.tsx); PLACA/MOTORISTA seguem a
   *     mesma convenção, agora também documentada na tela (ver VeiculoMotorista).
   */
  public static validate(
    policy: Policy,
    docData: ParsedDocumentData,
    supplementedVars: Record<string, any> = {}
  ): RuleValidationResult {
    const documentRules = dbStore.documentRules.filter(
      (r) => r.tipo_documento === docData.tipoDocumento
    );

    const insurerCoverages = dbStore.insurerCoverages.filter(
      (c) =>
        c.insurer_id === policy.insurer_id &&
        (!c.ramo || c.ramo === policy.ramo) &&
        (c.aplicar_todos_clientes || c.tenant_id === policy.tenant_id)
    );

    const policyRules = dbStore.policyRules.filter(
      (r) => r.policy_id === policy.id && (r.tipo_doc === 'TODOS' || r.tipo_doc === docData.tipoDocumento)
    );

    const missingVariables: string[] = [];

    // Mesclar tags do XML com variáveis suplementadas (via API ou Link de Recuperação)
    const combinedTags = { ...docData.tagsMap, ...supplementedVars };

    const hasValue = (tagPath: string | undefined, varName: string) => {
      const value1 = tagPath ? combinedTags[tagPath] : undefined;
      const value2 = combinedTags[varName];
      return (
        (value1 !== undefined && value1 !== null && value1 !== '') ||
        (value2 !== undefined && value2 !== null && value2 !== '')
      );
    };

    for (const rule of documentRules) {
      if (!rule.obrigatoria) continue;
      if (!hasValue(rule.tag_path, rule.nome_variavel)) {
        missingVariables.push(rule.nome_variavel);
      }
    }

    for (const coverage of insurerCoverages) {
      if (!coverage.obrigatoria) continue;
      if (!hasValue(undefined, coverage.titulo)) {
        missingVariables.push(coverage.titulo);
      }
    }

    for (const rule of policyRules) {
      if (!rule.obrigatoria) continue;
      if (!hasValue(rule.tag_path, rule.nome_variavel)) {
        missingVariables.push(rule.nome_variavel);
      }
    }

    const businessConfig = this.getBusinessConfig(policy);
    if (businessConfig['regras:placa'] === true && !hasValue('PLACA', 'Placa do Veículo')) {
      missingVariables.push('Placa do Veículo');
    }
    if (businessConfig['regras:motorista'] === true && !hasValue('MOTORISTA', 'Motorista (CPF/CNPJ)')) {
      missingVariables.push('Motorista (CPF/CNPJ)');
    }
    if (businessConfig['regras:embarque'] === true && !hasValue('DATA_EMBARQUE', 'Data de Embarque')) {
      missingVariables.push('Data de Embarque');
    }

    return {
      valid: missingVariables.length === 0,
      missingVariables
    };
  }

  /**
   * Soma o valor das coberturas adicionais MONETÁRIAS que foram encontradas preenchidas
   * no documento (via OBS/obsCont), para compor o valor final considerado na averbação.
   * Coberturas do tipo 'informativo' nunca entram nessa soma.
   */
  public static sumMonetaryCoverages(
    policy: Policy,
    docData: ParsedDocumentData,
    supplementedVars: Record<string, any> = {}
  ): { total: number; aplicadas: { titulo: string; valor: number }[] } {
    const combinedTags = { ...docData.tagsMap, ...supplementedVars };
    const insurerCoverages = dbStore.insurerCoverages.filter(
      (c) =>
        c.insurer_id === policy.insurer_id &&
        c.tipo_valor === 'monetario' &&
        (!c.ramo || c.ramo === policy.ramo) &&
        (c.aplicar_todos_clientes || c.tenant_id === policy.tenant_id)
    );

    let total = 0;
    const aplicadas: { titulo: string; valor: number }[] = [];

    for (const coverage of insurerCoverages) {
      const rawValue = combinedTags[coverage.titulo];
      if (rawValue === undefined || rawValue === null || rawValue === '') continue;

      // Extrai o número de strings tipo "R$ 25.000,00" -> 25000.00
      const numeric = this.parseMoneyBR(rawValue);

      if (!isNaN(numeric) && numeric > 0) {
        total += numeric;
        aplicadas.push({ titulo: coverage.titulo, valor: numeric });
      }
    }

    return { total, aplicadas };
  }
}
