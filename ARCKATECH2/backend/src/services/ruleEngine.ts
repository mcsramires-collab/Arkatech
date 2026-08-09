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
   *  2) as variáveis de negócio obrigatórias definidas na APÓLICE usada (PolicyRule)
   */
  public static validate(
    policy: Policy,
    docData: ParsedDocumentData,
    supplementedVars: Record<string, any> = {}
  ): RuleValidationResult {
    const documentRules = dbStore.documentRules.filter(
      (r) => r.tipo_documento === docData.tipoDocumento
    );

    const policyRules = dbStore.policyRules.filter(
      (r) => r.policy_id === policy.id && (r.tipo_doc === 'TODOS' || r.tipo_doc === docData.tipoDocumento)
    );

    const missingVariables: string[] = [];

    // Mesclar tags do XML com variáveis suplementadas (via API ou Link de Recuperação)
    const combinedTags = { ...docData.tagsMap, ...supplementedVars };

    const hasValue = (tagPath: string, varName: string) => {
      const value1 = combinedTags[tagPath];
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
}
