const SAFE_NON_PRODUCTION_VALUES = new Set([
  'test',
  'teste',
  'development',
  'dev',
  'local',
  'staging',
  'homologacao',
  'homologation'
]);

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled']);

export interface TestLabSafetyStatus {
  execution_allowed: boolean;
  production_like_runtime: boolean;
  explicit_opt_in: boolean;
  explicit_disabled: boolean;
  runtime_markers: Record<string, string>;
  reason?: 'TEST_LAB_DISABLED' | 'TEST_LAB_PRODUCTION_BLOCKED';
}

function normalized(name: string): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  return value || undefined;
}

function runtimeMarkers() {
  return Object.fromEntries(
    ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOYMENT_ENV']
      .map((name) => [name, process.env[name]?.trim()] as const)
      .filter(([, value]) => Boolean(value))
  );
}

function isProductionLikeRuntime(): boolean {
  const values = ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOYMENT_ENV']
    .map(normalized)
    .filter((value): value is string => Boolean(value));

  // Runtime sem marcador explícito segue o comportamento histórico de dev/local.
  if (values.length === 0) return false;
  return values.some((value) => !SAFE_NON_PRODUCTION_VALUES.has(value));
}

function featureFlag() {
  const value = normalized('TEST_LAB_ENABLED');
  return {
    explicit_opt_in: Boolean(value && TRUTHY.has(value)),
    explicit_disabled: Boolean(value && FALSY.has(value))
  };
}

export class TestLabSafetyService {
  static status(): TestLabSafetyStatus {
    const production_like_runtime = isProductionLikeRuntime();
    const { explicit_opt_in, explicit_disabled } = featureFlag();

    if (explicit_disabled) {
      return {
        execution_allowed: false,
        production_like_runtime,
        explicit_opt_in,
        explicit_disabled,
        runtime_markers: runtimeMarkers(),
        reason: 'TEST_LAB_DISABLED'
      };
    }

    if (production_like_runtime && !explicit_opt_in) {
      return {
        execution_allowed: false,
        production_like_runtime,
        explicit_opt_in,
        explicit_disabled,
        runtime_markers: runtimeMarkers(),
        reason: 'TEST_LAB_PRODUCTION_BLOCKED'
      };
    }

    return {
      execution_allowed: true,
      production_like_runtime,
      explicit_opt_in,
      explicit_disabled,
      runtime_markers: runtimeMarkers()
    };
  }

  static assertExecutionAllowed() {
    const status = this.status();
    if (!status.execution_allowed) {
      throw new Error(status.reason ?? 'TEST_LAB_DISABLED');
    }
  }
}
