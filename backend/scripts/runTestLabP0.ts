import { getTestLabCatalog } from '../src/services/testLabCatalog';
import { TestLabCatalogAuditService } from '../src/services/testLabCatalogAudit';
import { TestLabRunnerService } from '../src/services/testLabRunner';

async function main() {
  const audit = TestLabCatalogAuditService.audit();
  if (!audit.ok) {
    console.error('[test-lab] Flags de negócio sem catálogo:', audit.uncatalogued_business_keys);
    process.exitCode = 1;
    return;
  }

  const p0Suites = getTestLabCatalog().suites
    .filter((suite) => suite.priority === 'P0')
    .map((suite) => suite.key);

  const run = await TestLabRunnerService.execute({
    mode: 'STANDARD',
    suite_keys: p0Suites
  });

  console.log(
    '[test-lab] P0 total=' + run.total_executed +
    ' pass=' + run.passed +
    ' fail=' + run.failed +
    ' gap=' + run.gaps +
    ' duration_ms=' + run.duration_ms
  );

  for (const result of run.scenario_results.filter((item) => item.status !== 'PASS')) {
    console.error(
      '[test-lab] ' + result.status + ' ' + result.id + ': ' +
      (result.error || result.assertions.filter((item) => !item.pass).map((item) =>
        item.key + ' esperado=' + JSON.stringify(item.expected) + ' atual=' + JSON.stringify(item.actual)
      ).join('; '))
    );
  }

  if (run.failed > 0 || run.gaps > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[test-lab] Erro fatal:', error);
  process.exitCode = 1;
});
