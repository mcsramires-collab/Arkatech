import { normalizeCnpj } from '../utils/cnpj';
import { ParsedDocumentData } from './xmlParser';

export interface TitularityRuleLike {
  funcao: string;
  habilitada: boolean;
}

export interface TitularityMatch {
  matched: boolean;
  funcao?: string;
}

/**
 * Resolve Regra A sem misturar funções exclusivas da NF-e com os demais documentos.
 *
 * Mantemos os nomes genéricos legados (DESTINATARIO, TRANSPORTADOR...) e aceitamos aliases
 * explícitos de NF-e que o Portal da Seguradora já modela localmente. Assim uma seguradora pode
 * dizer "NF-e: Destinatário" sem, por acidente, liberar DESTINATARIO também em CT-e/NFS-e.
 */
export class DocumentTitularityService {
  private static norm(value?: string | number): string | undefined {
    return value !== undefined && value !== null ? normalizeCnpj(value) : undefined;
  }

  private static roleValues(parsedDoc: ParsedDocumentData): Record<string, Array<string | undefined>> {
    const generic: Record<string, Array<string | undefined>> = {
      DESTINATARIO: [this.norm(parsedDoc.cnpjDestinatario)],
      REMETENTE: [this.norm(parsedDoc.cnpjRemetente)],
      TOMADOR: [this.norm(parsedDoc.cnpjTomador)],
      EXPEDIDOR: [this.norm(parsedDoc.cnpjExpedidor)],
      RECEBEDOR: [this.norm(parsedDoc.cnpjRecebedor)],
      TRANSPORTADOR: [this.norm(parsedDoc.cnpjTransportador)]
    };

    if (parsedDoc.tipoDocumento === 'NFE') {
      const destinatario = this.norm(parsedDoc.cnpjDestinatario);
      const transportador = this.norm(parsedDoc.cnpjTransportador);
      const autorizados = (parsedDoc.autXmlIds ?? []).map((item) => this.norm(item));

      generic['NFE_DESTINATARIO'] = [destinatario];
      generic['NF-e: Destinatário'] = [destinatario];
      generic['NFE_TRANSPORTADOR'] = [transportador];
      generic['NF-e: Transportador'] = [transportador];
      generic['AUTORIZADO_XML'] = autorizados;
      generic['NFE_AUTXML'] = autorizados;
      generic['NF-e: autXML'] = autorizados;
    }

    return generic;
  }

  static match(
    parsedDoc: ParsedDocumentData,
    rules: TitularityRuleLike[],
    tenantCnpj: string
  ): TitularityMatch {
    const normalizedTenant = normalizeCnpj(tenantCnpj);
    const roles = this.roleValues(parsedDoc);

    for (const rule of rules) {
      if (!rule.habilitada) continue;
      const values = roles[rule.funcao];
      if (!values) continue;
      if (values.some((value) => value === normalizedTenant)) {
        return { matched: true, funcao: rule.funcao };
      }
    }

    return { matched: false };
  }
}
