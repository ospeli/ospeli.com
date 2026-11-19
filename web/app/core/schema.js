// A small JSON Schema checker (the subset the command layer uses): type, enum, const,
// required, properties, additionalProperties: false, items, minLength, maxLength, pattern,
// minimum, maximum, oneOf-free. Returns a list of plain-English errors; [] means valid.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

// An ISO time stamp as Ospeli writes and reads them: a date, or a date and time with Z or an offset.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export const isIsoTime = (v) => typeof v === 'string' && v.length <= 40 && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v));
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_UNKNOWN_NAMED = 5;

export function validate(schema, value, path = 'input') {
  const errs = [];
  if (!schema || schema === true) return errs;
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matchesType(value, t))) return [`${path} must be ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  if ('const' in schema && value !== schema.const) errs.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path} has the wrong format`);
    // A time is an ISO time stamp and nothing else. Date.parse alone also takes "7 Nov 2026 10:00
    // (any words here)", which let typed text ride in a time field into the proposal queue and
    // the audit trail (security review, 19 Nov).
    if (schema.format === 'date-time' && !isIsoTime(value)) errs.push(`${path} must be an ISO time stamp`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path} must be at most ${schema.maximum}`);
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) errs.push(`${path}.${k} is required`);
    let unknown = 0;
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) {
        // Say what is allowed, so the caller can put it right in one more call (#135). The allowed
        // list is said once, at most MAX_UNKNOWN_NAMED fields are named, and a field name that does
        // not look like a field name is never repeated back: it is typed text (19 Nov).
        unknown += 1;
        if (unknown > MAX_UNKNOWN_NAMED) continue;
        const named = FIELD_NAME.test(k) ? `${path}.${k}` : `A field of ${path} with a name Ospeli does not use`;
        errs.push(`${named} is not allowed.${unknown === 1 ? ` ${Object.keys(props).length ? `This takes: ${Object.keys(props).join(', ')}.` : 'This takes no input.'}` : ''}`);
      } else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
    if (unknown > MAX_UNKNOWN_NAMED) errs.push(`${unknown - MAX_UNKNOWN_NAMED} more fields of ${path} are not allowed.`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  return errs;
}
