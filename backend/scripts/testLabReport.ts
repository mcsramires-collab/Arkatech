import fs from 'fs';
import path from 'path';
import { TestLabRun } from '../src/types';
import { getTestLabCatalog } from '../src/services/testLabCatalog';
import { TestLabRunnerService } from '../src/services/testLabRunner';

export function saveTestLabReport(suite: string, run: TestLabRun) {
  const directory = path.resolve('test-results');
  fs.mkdirSync(directory, { recursive: true });
  const coverage = getTestLabCatalog().flags.map(flag => {
    const results = run.scenario_results.filter(result => result.covers_flag_keys.includes(flag.key));
    return { key: flag.key, engine_status: flag.engine_status, scenario_ids: results.map(r => r.id),
      status: flag.engine_status === 'PLANNED' ? 'GAP' : results.length === 0 ? 'NOT_RUN' : results.some(r => r.status === 'FAIL') ? 'FAIL' : results.some(r => r.status === 'GAP') ? 'GAP' : 'PASS' };
  });
  fs.writeFileSync(path.join(directory, suite + '.json'), JSON.stringify({ run, coverage }, null, 2));
  fs.writeFileSync(path.join(directory, suite + '.csv'), TestLabRunnerService.exportCsv(run.id));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const gaps = run.scenario_results.filter(r => r.status === 'GAP');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Test Lab ${suite}\n\nPASS: ${run.passed} · FAIL: ${run.failed} · GAP: ${run.gaps}\n\n` + gaps.map(g => `- GAP ${g.id}: ${g.error}`).join('\n') + '\n');
  }
}
