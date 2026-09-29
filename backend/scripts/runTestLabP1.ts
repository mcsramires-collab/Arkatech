import { getTestLabCatalog } from '../src/services/testLabCatalog';
import { TestLabCatalogAuditService } from '../src/services/testLabCatalogAudit';
import { TestLabRunnerService } from '../src/services/testLabRunner';
import { saveTestLabReport } from './testLabReport';

async function main() {
  const catalog = getTestLabCatalog();
  const audit = TestLabCatalogAuditService.audit();

  if (!audit.ok) {
    console.error('[test-lab:p1] Flags de negócio sem catálogo:', audit.uncatalogued_business_keys);
    process.exitCode = 1;
    return;
  }

  const p1Suites = catalog.suites
    .filter((suite) => suite.priority === 'P1')
    .map((suite) => suite.key);

  const run = await TestLabRunnerService.execute({
    mode: 'STANDARD',
    suite_keys: p1Suites
  });
  saveTestLabReport('p1', run);

  const flags = new Map(catalog.flags.map((flag) => [flag.key, flag]));
  const unexpectedGaps = run.scenario_results.filter((result) => {
    if (result.status !== 'GAP') return false;
    if (result.covers_flag_keys.length === 0) return true;
    return result.covers_flag_keys.some((key) => flags.get(key)?.engine_status !== 'PLANNED');
  });

  console.log(
    '[test-lab:p1] total=' + run.total_executed +
    ' pass=' + run.passed +
    ' fail=' + run.failed +
    ' gap=' + run.gaps +
    ' planned_gap=' + (run.gaps - unexpectedGaps.length) +
    ' unexpected_gap=' + unexpectedGaps.length +
    ' duration_ms=' + run.duration_ms
  );

  for (const result of run.scenario_results.filter((item) => item.status === 'FAIL')) {
    console.error(
      '[test-lab:p1] FAIL ' + result.id + ': ' +
      (result.error || result.assertions.filter((item) => !item.pass).map((item) =>
        item.key + ' esperado=' + JSON.stringify(item.expected) + ' atual=' + JSON.stringify(item.actual)
      ).join('; '))
    );
  }

  for (const result of unexpectedGaps) {
    console.error('[test-lab:p1] GAP inesperado ' + result.id + ': ' + (result.error || 'sem executor'));
  }

  if (run.failed > 0 || unexpectedGaps.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[test-lab:p1] Erro fatal:', error);
  process.exitCode = 1;
});
