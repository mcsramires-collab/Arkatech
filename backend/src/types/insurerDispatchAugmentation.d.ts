import './index';

declare module './index' {
  interface Averbacao {
    /** Id da tentativa persistida na outbox de envio à seguradora externa. */
    insurer_dispatch_id?: string;
    /** Protocolo/referência devolvido pelo adapter da seguradora após confirmação. */
    protocolo_seguradora?: string;
  }
}
