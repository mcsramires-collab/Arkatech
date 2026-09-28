import { TestLabFlagDefinition } from './testLabCatalog';

export type ScenarioDimensionValue = string | number | boolean | null;

export interface ScenarioDimension {
  key: string;
  values: ScenarioDimensionValue[];
}

export type ScenarioAssignment = Record<string, ScenarioDimensionValue>;

function isoDateOffset(days: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export class TestLabScenarioGenerator {
  static valuesForFlag(flag: TestLabFlagDefinition): ScenarioDimensionValue[] {
    if (flag.generation === 'BOOLEAN_BOTH') return [false, true];

    if (flag.generation === 'ENUM_ALL') {
      return (flag.options ?? []).map((option) => option.value);
    }

    if (flag.generation === 'NUMERIC_BOUNDARIES') {
      const suggested = (flag.suggested_values ?? []).filter(
        (value): value is number => typeof value === 'number'
      );
      const base = suggested.length > 0 ? suggested[suggested.length - 1]! : 100;
      const delta = Number.isInteger(base) ? 1 : 0.01;
      return [Math.max(0, base - delta), base, base + delta];
    }

    if (flag.generation === 'DATE_BOUNDARIES') {
      return [isoDateOffset(-1), isoDateOffset(0), isoDateOffset(1)];
    }

    if (flag.generation === 'PAIRWISE') {
      if (flag.options?.length) return flag.options.map((option) => option.value);
      if (flag.suggested_values?.length) return [...flag.suggested_values] as ScenarioDimensionValue[];
      return [null];
    }

    return [null];
  }

  static cartesian(dimensions: ScenarioDimension[], maxCases = 10000): ScenarioAssignment[] {
    if (dimensions.length === 0) return [{}];
    let assignments: ScenarioAssignment[] = [{}];

    for (const dimension of dimensions) {
      const next: ScenarioAssignment[] = [];
      for (const assignment of assignments) {
        for (const value of dimension.values) {
          next.push({ ...assignment, [dimension.key]: value });
          if (next.length >= maxCases) return next;
        }
      }
      assignments = next;
    }

    return assignments;
  }

  /**
   * Geração pairwise determinística por cobertura gulosa.
   *
   * Para matrizes pequenas, cria o cartesiano e seleciona somente os casos que cobrem o maior
   * número de pares ainda não exercitados. Isso evita 2^N cenários para flags booleanas e mantém
   * o resultado reproduzível. Em dimensões muito grandes o cartesiano é limitado.
   */
  static pairwise(dimensions: ScenarioDimension[], maxCartesian = 5000): ScenarioAssignment[] {
    if (dimensions.length <= 1) return this.cartesian(dimensions, maxCartesian);

    const candidates = this.cartesian(dimensions, maxCartesian);
    const pairKey = (
      leftKey: string,
      leftValue: ScenarioDimensionValue,
      rightKey: string,
      rightValue: ScenarioDimensionValue
    ) => `${leftKey}=${JSON.stringify(leftValue)}|${rightKey}=${JSON.stringify(rightValue)}`;

    const uncovered = new Set<string>();
    for (let i = 0; i < dimensions.length; i += 1) {
      for (let j = i + 1; j < dimensions.length; j += 1) {
        for (const left of dimensions[i]!.values) {
          for (const right of dimensions[j]!.values) {
            uncovered.add(pairKey(dimensions[i]!.key, left, dimensions[j]!.key, right));
          }
        }
      }
    }

    const pairsFor = (assignment: ScenarioAssignment): string[] => {
      const pairs: string[] = [];
      for (let i = 0; i < dimensions.length; i += 1) {
        for (let j = i + 1; j < dimensions.length; j += 1) {
          const left = dimensions[i]!;
          const right = dimensions[j]!;
          pairs.push(pairKey(left.key, assignment[left.key] ?? null, right.key, assignment[right.key] ?? null));
        }
      }
      return pairs;
    };

    const selected: ScenarioAssignment[] = [];
    const remaining = [...candidates];

    while (uncovered.size > 0 && remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = -1;

      for (let index = 0; index < remaining.length; index += 1) {
        const score = pairsFor(remaining[index]!).filter((pair) => uncovered.has(pair)).length;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }

      if (bestScore <= 0) break;
      const [best] = remaining.splice(bestIndex, 1);
      if (!best) break;
      selected.push(best);
      for (const pair of pairsFor(best)) uncovered.delete(pair);
    }

    return selected.length > 0 ? selected : candidates.slice(0, 1);
  }

  static estimateCartesian(dimensions: ScenarioDimension[]): number {
    return dimensions.reduce(
      (total, dimension) => total * Math.max(1, dimension.values.length),
      1
    );
  }
}
