const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Suspension bounds are inclusive instants, as in the existing policy engine.
 * Date-only bounds retain their existing meaning: midnight UTC, even for the end.
 * Reject JS Date's permissive parsing (local times, rollovers, numeric values).
 */
export function parseSuspensionDate(value: unknown): number | null {
  if (typeof value !== 'string' || (!DATE_ONLY.test(value) && !ZONED_TIMESTAMP.test(value))) {
    return null;
  }

  // Date.parse normalizes impossible days such as February 30; compare the calendar
  // portion before applying an offset so a valid timezone crossing stays valid.
  const calendarDate = value.slice(0, 10);
  const midnight = new Date(`${calendarDate}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== calendarDate) {
    return null;
  }

  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}
