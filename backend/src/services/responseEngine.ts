import { dbStore } from './dbStore';

export class ResponseEngine {
  /**
   * Formata a mensagem de retorno da API buscando o template no banco de dados e substituindo os placeholders dinâmicos.
   */
  public static formatResponse(
    codigo: string,
    replacements: Record<string, string> = {}
  ): { codigo: string; tipo: string; mensagem: string } {
    const template = dbStore.responseTemplates.find((t) => t.codigo === codigo);

    if (!template) {
      return {
        codigo,
        tipo: 'erro',
        mensagem: `Mensagem de retorno [${codigo}] não configurada no banco de dados.`
      };
    }

    let textoFinal = template.texto_customizado || template.texto_padrao;

    // Interpolação de placeholders (ex: [NUMERO_AVERBACAO], [TIMESTAMP], [NOME_VARIAVEL])
    for (const [key, value] of Object.entries(replacements)) {
      const placeholder = key.startsWith('[') && key.endsWith(']') ? key : `[${key}]`;
      textoFinal = textoFinal.split(placeholder).join(value);
    }

    return {
      codigo: template.codigo,
      tipo: template.tipo,
      mensagem: textoFinal
    };
  }
}
