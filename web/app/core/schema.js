// A small JSON Schema checker (the subset the command layer uses): type, enum, const,
// required, properties, additionalProperties: false, items, minLength, maxLength, pattern,
// minimum, maximum, oneOf-free. Returns a list of plain-English errors; [] means valid.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

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
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errs.push(`${path} must be an ISO time stamp`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path} must be at most ${schema.maximum}`);
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) errs.push(`${path}.${k} is required`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not allowed`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  return errs;
}
