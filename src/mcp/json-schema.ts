/** Dependency-free JSON Schema validator for MCP tool argument boundaries. */

export interface JsonSchemaValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function label(path: readonly (string | number)[]): string {
  return path.length === 0 ? 'value' : 'value' + path.map((part) => typeof part === 'number' ? '[' + part + ']' : '.' + part).join('');
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equalJson(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ar = a as Record<string, unknown>;
    const br = b as Record<string, unknown>;
    const ak = Object.keys(ar).sort();
    const bk = Object.keys(br).sort();
    return ak.length === bk.length && ak.every((key, i) => key === bk[i] && equalJson(ar[key], br[key]));
  }
  return false;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: return true;
  }
}

function validate(value: unknown, schema: unknown, path: readonly (string | number)[]): JsonSchemaValidationIssue[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [{ path, message: label(path) + ' is not allowed by the schema' }];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const issues: JsonSchemaValidationIssue[] = [];

  if (s['nullable'] === true && value === null) return issues;

  const type = s['type'];
  if (typeof type === 'string' && !matchesType(value, type)) {
    return [{ path, message: label(path) + ' must be ' + type }];
  }
  if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && matchesType(value, t))) {
    return [{ path, message: label(path) + ' must match one of: ' + type.join(', ') }];
  }

  if ('const' in s && !equalJson(value, s['const'])) issues.push({ path, message: label(path) + ' must equal the schema const value' });
  const enumValues = s['enum'];
  if (Array.isArray(enumValues) && !enumValues.some((item) => equalJson(value, item))) issues.push({ path, message: label(path) + ' must be one of the allowed enum values' });

  const anyOf = s['anyOf'];
  if (Array.isArray(anyOf) && !anyOf.some((candidate) => validate(value, candidate, path).length === 0)) issues.push({ path, message: label(path) + ' must satisfy at least one anyOf schema' });
  const oneOf = s['oneOf'];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((candidate) => validate(value, candidate, path).length === 0).length;
    if (matches !== 1) issues.push({ path, message: label(path) + ' must satisfy exactly one oneOf schema' });
  }
  const allOf = s['allOf'];
  if (Array.isArray(allOf)) for (const candidate of allOf) issues.push(...validate(value, candidate, path));
  if ('not' in s && validate(value, s['not'], path).length === 0) issues.push({ path, message: label(path) + ' must not satisfy the not schema' });

  if (typeof value === 'string') {
    const min = s['minLength'];
    const max = s['maxLength'];
    if (typeof min === 'number' && value.length < min) issues.push({ path, message: label(path) + ' must have at least ' + min + ' characters' });
    if (typeof max === 'number' && value.length > max) issues.push({ path, message: label(path) + ' must have at most ' + max + ' characters' });
    if (typeof s['pattern'] === 'string') {
      try { if (!new RegExp(s['pattern']).test(value)) issues.push({ path, message: label(path) + ' does not match the required pattern' }); }
      catch { /* malformed provider regex; do not reject otherwise valid arguments */ }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const numericRules: readonly [string, (n: number, bound: number) => boolean, string][] = [
      ['minimum', (n, b) => n >= b, 'must be greater than or equal to'],
      ['maximum', (n, b) => n <= b, 'must be less than or equal to'],
      ['exclusiveMinimum', (n, b) => n > b, 'must be greater than'],
      ['exclusiveMaximum', (n, b) => n < b, 'must be less than'],
    ];
    for (const [keyword, check, phrase] of numericRules) {
      const bound = s[keyword];
      if (typeof bound === 'number' && !check(value, bound)) issues.push({ path, message: label(path) + ' ' + phrase + ' ' + bound });
    }
    const multipleOf = s['multipleOf'];
    if (typeof multipleOf === 'number' && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-12) issues.push({ path, message: label(path) + ' must be a multiple of ' + multipleOf });
    }
  }

  if (Array.isArray(value)) {
    const min = s['minItems'];
    const max = s['maxItems'];
    if (typeof min === 'number' && value.length < min) issues.push({ path, message: label(path) + ' must contain at least ' + min + ' items' });
    if (typeof max === 'number' && value.length > max) issues.push({ path, message: label(path) + ' must contain at most ' + max + ' items' });
    if (s['uniqueItems'] === true) {
      for (let i = 0; i < value.length; i += 1) if (value.slice(0, i).some((previous) => equalJson(previous, value[i]))) { issues.push({ path: [...path, i], message: label([...path, i]) + ' must be unique' }); break; }
    }
    if ('items' in s) value.forEach((item, i) => issues.push(...validate(item, s['items'], [...path, i])));
    if (Array.isArray(s['prefixItems'])) s['prefixItems'].forEach((itemSchema, i) => { if (i < value.length) issues.push(...validate(value[i], itemSchema, [...path, i])); });
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const required = s['required'];
    if (Array.isArray(required)) for (const key of required) if (typeof key === 'string' && !(key in object)) issues.push({ path: [...path, key], message: label([...path, key]) + ' is required' });
    const properties = s['properties'];
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      const propertySchemas = properties as Record<string, unknown>;
      for (const [key, propertySchema] of Object.entries(propertySchemas)) if (key in object) issues.push(...validate(object[key], propertySchema, [...path, key]));
      const additional = s['additionalProperties'];
      for (const key of Object.keys(object)) {
        if (key in propertySchemas) continue;
        if (additional === false) issues.push({ path: [...path, key], message: label([...path, key]) + ' is not allowed' });
        else if (additional !== true && additional !== undefined) issues.push(...validate(object[key], additional, [...path, key]));
      }
    }
    const min = s['minProperties'];
    const max = s['maxProperties'];
    if (typeof min === 'number' && Object.keys(object).length < min) issues.push({ path, message: label(path) + ' must contain at least ' + min + ' properties' });
    if (typeof max === 'number' && Object.keys(object).length > max) issues.push({ path, message: label(path) + ' must contain at most ' + max + ' properties' });
  }

  return issues;
}

export function validateJsonSchema(value: unknown, schema: unknown): readonly JsonSchemaValidationIssue[] {
  return validate(value, schema, []);
}