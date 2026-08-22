import { dbStore } from './dbStore';

export class ResponseEngine {
  /**
   * Formata a mensagem de retorno da API buscando o template no banco de dados e substituindo os placeholders dinâmicos.
   */
  public static formatResponse(
    codigo: string,
    replacements: Record<string, string> = {}
  ): { codigo: string; tipo: string; mensagem: string; explicacao_nao_tecnica?: string; orientacao_correcao?: string } {
    const template = dbStore.responseTemplates.find((t) => t.codigo === codigo);

    if (!template) {
      return {
        codigo,
        tipo: 'erro',
        mensagem: `Mensagem de retorno [${codigo}] não configurada no banco de dados.`
      };
    }

    const interpolate = (text: string | undefined) => {
      if (!text) return text;
      let result = text;
      for (const [key, value] of Object.entries(replacements)) {
        const placeholder = key.startsWith('[') && key.endsWith(']') ? key : `[${key}]`;
        result = result.split(placeholder).join(value);
      }
      return result;
    };

    return {
      codigo: template.codigo,
      tipo: template.tipo,
      mensagem: interpolate(template.texto_customizado || template.texto_padrao) as string,
      explicacao_nao_tecnica: interpolate(template.explicacao_nao_tecnica),
      orientacao_correcao: interpolate(template.orientacao_correcao)
    };
  }
}
