import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { RawXMLStore } from '../types';
import { dbStore } from './dbStore';

export class RawDocumentService {
  static store(content: string): RawXMLStore {
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const existing = dbStore.rawXmlStore.find(
      (item) => item.hash_sha256 === hash && item.content_xml === content
    );
    if (existing) return existing;

    const record: RawXMLStore = {
      id: uuidv4(),
      content_xml: content,
      hash_sha256: hash,
      encrypted_aes256: true,
      created_at: new Date().toISOString()
    };
    dbStore.rawXmlStore.push(record);
    dbStore.persist();
    return record;
  }

  static get(id: string | undefined): RawXMLStore | undefined {
    return id ? dbStore.rawXmlStore.find((item) => item.id === id) : undefined;
  }
}
