import { TestLabScenarioGenerator } from './testLabScenarioGenerator';

describe('TestLabScenarioGenerator', () => {
  test('gera os dois lados de uma flag booleana', () => {
    expect(
      TestLabScenarioGenerator.valuesForFlag({
        key: 'x',
        group: 'g',
        label: 'X',
        description: 'X',
        source: { kind: 'BUSINESS_SETTING', path: 'x' },
        value_type: 'BOOLEAN',
        engine_status: 'ACTIVE',
        generation: 'BOOLEAN_BOTH',
        tags: []
      })
    ).toEqual([false, true]);
  });

  test('gera fronteiras numéricas abaixo igual e acima', () => {
    expect(
      TestLabScenarioGenerator.valuesForFlag({
        key: 'lmi',
        group: 'limits',
        label: 'LMI',
        description: 'LMI',
        source: { kind: 'POLICY_FIELD', path: 'Policy.lmi' },
        value_type: 'NUMBER',
        engine_status: 'ACTIVE',
        generation: 'NUMERIC_BOUNDARIES',
        suggested_values: [1000],
        tags: []
      })
    ).toEqual([999, 1000, 1001]);
  });

  test('pairwise cobre todos os pares sem executar todo o cartesiano', () => {
    const dimensions = [
      { key: 'a', values: [false, true] },
      { key: 'b', values: ['x', 'y', 'z'] },
      { key: 'c', values: [1, 2] },
      { key: 'd', values: ['m', 'n'] }
    ];

    const cases = TestLabScenarioGenerator.pairwise(dimensions);
    expect(cases.length).toBeLessThan(24);

    const observed = new Set<string>();
    for (const assignment of cases) {
      for (let i = 0; i < dimensions.length; i += 1) {
        for (let j = i + 1; j < dimensions.length; j += 1) {
          const left = dimensions[i]!;
          const right = dimensions[j]!;
          observed.add(
            left.key + '=' + JSON.stringify(assignment[left.key]) +
            '|' + right.key + '=' + JSON.stringify(assignment[right.key])
          );
        }
      }
    }

    for (let i = 0; i < dimensions.length; i += 1) {
      for (let j = i + 1; j < dimensions.length; j += 1) {
        for (const leftValue of dimensions[i]!.values) {
          for (const rightValue of dimensions[j]!.values) {
            expect(
              observed.has(
                dimensions[i]!.key + '=' + JSON.stringify(leftValue) +
                '|' + dimensions[j]!.key + '=' + JSON.stringify(rightValue)
              )
            ).toBe(true);
          }
        }
      }
    }
  });
});
