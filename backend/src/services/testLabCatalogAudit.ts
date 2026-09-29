import fs from 'fs';
import path from 'path';
import { dbStore } from './dbStore';
import { getTestLabCatalog } from './testLabCatalog';

export interface TestLabCatalogAudit {
  detected_business_keys: string[];
  catalogued_keys: string[];
  uncatalogued_business_keys: string[];
  catalogued_not_detected_in_backend: string[];
  ok: boolean;
}

function walkTsFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTsFiles(full));
    } else if (/\.[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name) && !entry.name.startsWith('testLab')) {
      result.push(full);
    }
  }
  return result;
}

function extractRuleKeys(source: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /['"]((?:regras|recusas|rcv):[A-Za-z0-9_:-]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return [...keys];
}

export class TestLabCatalogAuditService {
  static audit(): TestLabCatalogAudit {
    const detected = new Set<string>();

    const roots = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../frontend/src')];
    if (process.env.TEST_LAB_UI_SOURCE) roots.push(path.resolve(process.env.TEST_LAB_UI_SOURCE));
    for (const file of roots.flatMap(walkTsFiles)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const key of extractRuleKeys(source)) detected.add(key);
    }

    // Também considera configurações já persistidas. Isso captura flags antigas/customizadas
    // mesmo quando a referência foi removida/movida de arquivo.
    for (const settings of dbStore.policyBusinessSettings) {
      for (const key of Object.keys(settings.config ?? {})) {
        detected.add(key);
      }
    }

    const catalog = getTestLabCatalog();
    const catalogued = new Set(catalog.flags.map((flag) => flag.key));
    const businessKeys = [...detected].sort();
    const uncatalogued = businessKeys.filter((key) => !catalogued.has(key));
    const cataloguedBusiness = [...catalogued]
      .filter((key) => /^(regras|recusas|rcv):/.test(key))
      .sort();
    const notDetected = cataloguedBusiness.filter((key) => !detected.has(key));

    return {
      detected_business_keys: businessKeys,
      catalogued_keys: [...catalogued].sort(),
      uncatalogued_business_keys: uncatalogued,
      catalogued_not_detected_in_backend: notDetected,
      ok: uncatalogued.length === 0
    };
  }
}
