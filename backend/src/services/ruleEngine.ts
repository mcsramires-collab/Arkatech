import { dbStore } from './dbStore';
import { Policy } from '../types';
import { ParsedDocumentData } from './xmlParser';

export interface RuleValidationResult {
  valid: boolean;
  missingVariables: string[];
}

export class RuleEngineService {
  /**
   * Avalia se o documento atende:
   *  1) as tags obrigatórias do PADRÃO SEFAZ para aquele TIPO DE DOCUMENTO
   *     (DocumentRule — vale para todos os documentos daquele tipo, independente da apólice)
   *  2) as coberturas adicionais obrigatórias configuradas pela SEGURADORA (InsurerCoverage —
   *     podem valer para todos os clientes dela ou só para este tenant específico)
   *  3) as variáveis de negócio obrigatórias definidas diretamente na APÓLICE (PolicyRule — legado)
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
      const numeric = Number(
        String(rawValue)
          .replace(/[^\d,.-]/g, '')
          .replace(/\.(?=\d{3},)/g, '')
          .replace(',', '.')
      );

      if (!isNaN(numeric) && numeric > 0) {
        total += numeric;
        aplicadas.push({ titulo: coverage.titulo, valor: numeric });
      }
    }

    return { total, aplicadas };
  }
}
