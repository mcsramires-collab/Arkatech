import { TestLabFlagDefinition } from './testLabCatalog';

export type ScenarioDimensionValue = string | number | boolean | null;
export interface ScenarioDimension { key: string; values: ScenarioDimensionValue[] }
export type ScenarioAssignment = Record<string, ScenarioDimensionValue>;

export class TestLabScenarioGenerator {
  static valuesForFlag(flag: TestLabFlagDefinition, referenceDate = '2026-09-28T12:00:00.000Z'): ScenarioDimensionValue[] {
    if (flag.generation === 'BOOLEAN_BOTH') return [false, true];
    if (flag.generation === 'ENUM_ALL') return (flag.options ?? []).map(option => option.value);
    if (flag.generation === 'NUMERIC_BOUNDARIES') {
      const suggested = (flag.suggested_values ?? []).filter((v): v is number => typeof v === 'number');
      const base = suggested.length ? suggested[suggested.length - 1]! : 100;
      const delta = Number.isInteger(base) ? 1 : 0.01;
      return [Math.max(0, base - delta), base, base + delta];
    }
    if (flag.generation === 'DATE_BOUNDARIES') {
      const base = Date.parse(referenceDate);
      if (!Number.isFinite(base)) throw new Error('TEST_LAB_INVALID_REFERENCE_DATE');
      return [-86400000, 0, 86400000].map(offset => new Date(base + offset).toISOString());
    }
    if (flag.options?.length) return flag.options.map(option => option.value);
    if (flag.suggested_values?.length) return [...flag.suggested_values];
    return [null];
  }

  private static validate(dimensions: ScenarioDimension[]) {
    if (new Set(dimensions.map(d => d.key)).size !== dimensions.length || dimensions.some(d => !d.key || !d.values.length)) {
      throw new Error('TEST_LAB_INVALID_DIMENSIONS');
    }
  }

  static cartesian(dimensions: ScenarioDimension[], maxCases = 10000): ScenarioAssignment[] {
    this.validate(dimensions);
    if (this.estimateCartesian(dimensions) > maxCases) throw new Error('TEST_LAB_MATRIX_LIMIT');
    return dimensions.reduce<ScenarioAssignment[]>((rows, dimension) => rows.flatMap(row =>
      dimension.values.map(value => ({ ...row, [dimension.key]: value }))), [{}]);
  }

  /** Deterministic pair covering without truncating the Cartesian product. */
  static pairwise(dimensions: ScenarioDimension[], _maxCartesian = 5000): ScenarioAssignment[] {
    this.validate(dimensions);
    if (dimensions.length <= 1) return this.cartesian(dimensions);
    const key = (i: number, a: ScenarioDimensionValue, j: number, b: ScenarioDimensionValue) => JSON.stringify([i, a, j, b]);
    const uncovered = new Map<string, [number, ScenarioDimensionValue, number, ScenarioDimensionValue]>();
    for (let i = 0; i < dimensions.length; i++) for (let j = i + 1; j < dimensions.length; j++) {
      for (const a of dimensions[i]!.values) for (const b of dimensions[j]!.values) uncovered.set(key(i,a,j,b), [i,a,j,b]);
    }
    const result: ScenarioAssignment[] = [];
    while (uncovered.size) {
      const [i,a,j,b] = uncovered.values().next().value!;
      const chosen = new Map<number, ScenarioDimensionValue>([[i,a], [j,b]]);
      for (let d = 0; d < dimensions.length; d++) {
        if (chosen.has(d)) continue;
        let best: ScenarioDimensionValue = dimensions[d]!.values[0]!;
        let bestScore = -1;
        for (const value of dimensions[d]!.values) {
          let score = 0;
          for (const [other, v] of chosen) {
            if (uncovered.has(d < other ? key(d,value,other,v) : key(other,v,d,value))) score++;
          }
          if (score > bestScore) { best = value; bestScore = score; }
        }
        chosen.set(d, best);
      }
      for (let l = 0; l < dimensions.length; l++) for (let r = l + 1; r < dimensions.length; r++) {
        uncovered.delete(key(l,chosen.get(l)!,r,chosen.get(r)!));
      }
      result.push(Object.fromEntries(dimensions.map((d,index) => [d.key, chosen.get(index)!])));
    }
    return result;
  }

  static invariantMatrix(dimensions: ScenarioDimension[]): ScenarioAssignment[] {
    return this.cartesian(dimensions);
  }

  static estimateCartesian(dimensions: ScenarioDimension[]): number {
    return dimensions.reduce((total, dimension) => total * dimension.values.length, 1);
  }
}
