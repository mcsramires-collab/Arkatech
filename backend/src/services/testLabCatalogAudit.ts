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
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

function extractRuleKeys(source: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /\[['"](regras:[^'"]+)['"]\]/g,
    /['"](regras:[^'"]+)['"]\s*:/g
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

    const srcRoot = path.join(process.cwd(), 'src');
    for (const file of walkTsFiles(srcRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const key of extractRuleKeys(source)) detected.add(key);
    }

    // Também considera configurações já persistidas. Isso captura flags antigas/customizadas
    // mesmo quando a referência foi removida/movida de arquivo.
    for (const settings of dbStore.policyBusinessSettings) {
      for (const key of Object.keys(settings.config ?? {})) {
        if (key.startsWith('regras:')) detected.add(key);
      }
    }

    const catalog = getTestLabCatalog();
    const catalogued = new Set(catalog.flags.map((flag) => flag.key));
    const businessKeys = [...detected].sort();
    const uncatalogued = businessKeys.filter((key) => !catalogued.has(key));
    const cataloguedBusiness = [...catalogued]
      .filter((key) => key.startsWith('regras:'))
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
