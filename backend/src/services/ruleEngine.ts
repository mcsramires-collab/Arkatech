import { dbStore } from './dbStore';
import { Policy, TipoDocumento } from '../types';
import { ParsedDocumentData } from './xmlParser';

export interface RuleValidationResult {
  valid: boolean;
  missingVariables: string[];
}

export class RuleEngineService {
  /**
   * Avalia se o documento atende a todas as regras e variáveis obrigatórias cadastradas para a apólice.
   */
  public static validate(
    policy: Policy,
    docData: ParsedDocumentData,
    supplementedVars: Record<string, any> = {}
  ): RuleValidationResult {
    const rules = dbStore.policyRules.filter(
      (r) => r.policy_id === policy.id && (r.tipo_doc === 'TODOS' || r.tipo_doc === docData.tipoDocumento)
    );

    const missingVariables: string[] = [];

    // Mesclar tags do XML com variáveis suplementadas (via API ou Link de Recuperação)
    const combinedTags = { ...docData.tagsMap, ...supplementedVars };

    for (const rule of rules) {
      if (!rule.obrigatoria) continue;

      const tagPath = rule.tag_path;
      const varName = rule.nome_variavel;

      // Verificar se a tag ou o nome da variável possui valor preenchido
      const value1 = combinedTags[tagPath];
      const value2 = combinedTags[varName];

      const hasValue =
        (value1 !== undefined && value1 !== null && value1 !== '') ||
        (value2 !== undefined && value2 !== null && value2 !== '');

      if (!hasValue) {
        missingVariables.push(rule.nome_variavel);
      }
    }

    return {
      valid: missingVariables.length === 0,
      missingVariables
    };
  }
}
