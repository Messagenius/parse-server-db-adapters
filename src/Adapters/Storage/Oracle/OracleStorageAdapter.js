// @flow
import { createClient, getOracledb } from './OracleClient';
// @flow-disable-next
import Parse from 'parse/node';
// @flow-disable-next
import _ from 'lodash';
// @flow-disable-next
import { v4 as uuidv4 } from 'uuid';
import { StorageAdapter } from '../StorageAdapter';
import type { SchemaType, QueryType, QueryOptions } from '../StorageAdapter';
const Utils = require('../../../Utils');
const oracleSql = require('./sql');

// Oracle error codes
const OracleTableDoesNotExistError = 942; // ORA-00942: table or view does not exist
const OracleDuplicateTableError = 955; // ORA-00955: name is already used by an existing object
const OracleDuplicateColumnError = 1430; // ORA-01430: column being added already exists
const OracleMissingColumnError = 904; // ORA-00904: invalid identifier
const OracleUniqueConstraintViolation = 1; // ORA-00001: unique constraint violated
const OracleInvalidIdentifier = 904; // ORA-00904
const OracleDDLConcurrentError = 14411; // ORA-14411: The DDL cannot be run concurrently with other DDLs

const logger = require('../../../logger');

const debug = function (...args: any) {
  args = ['ORACLE: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
};

const ORACLE_VARCHAR_MAX = 4000;

// Map Parse types to Oracle SQL types
const parseTypeToOracleType = type => {
  switch (type.type) {
    case 'String':
      return 'VARCHAR2(4000)';
    case 'Date':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'Object':
      return 'CLOB'; // Store JSON as CLOB
    case 'File':
      return 'VARCHAR2(1024)';
    case 'Boolean':
      return 'NUMBER(1)'; // Oracle has no boolean type for tables
    case 'Pointer':
      return 'VARCHAR2(120)';
    case 'Number':
      return 'NUMBER';
    case 'GeoPoint':
      // Deferred to Milestone 2 - store as CLOB (JSON) for now
      return 'CLOB';
    case 'Bytes':
      return 'CLOB';
    case 'Polygon':
      // Deferred to Milestone 2 - store as CLOB (JSON) for now
      return 'CLOB';
    case 'Array':
      // Oracle doesn't have native arrays, store as JSON in CLOB
      return 'CLOB';
    default:
      throw `no type for ${JSON.stringify(type)} yet`;
  }
};

// Parse comparison operators to Oracle SQL
const ParseToOracleComparator = {
  $gt: '>',
  $lt: '<',
  $gte: '>=',
  $lte: '<=',
};

// Mongo aggregate date parts to Oracle EXTRACT/TO_CHAR format
// Oracle EXTRACT supports: YEAR, MONTH, DAY, HOUR, MINUTE, SECOND
// For others, we use TO_CHAR with format masks
const mongoAggregateToOracle = {
  $dayOfMonth: { type: 'EXTRACT', value: 'DAY' },
  $dayOfWeek: { type: 'TO_CHAR', value: 'D' }, // Oracle D: 1-7, Sunday=1
  $dayOfYear: { type: 'TO_CHAR', value: 'DDD' },
  $isoDayOfWeek: { type: 'TO_CHAR', value: 'D' }, // ISO day of week (adjusted)
  $isoWeekYear: { type: 'TO_CHAR', value: 'IYYY' }, // ISO year
  $hour: { type: 'EXTRACT', value: 'HOUR' },
  $minute: { type: 'EXTRACT', value: 'MINUTE' },
  $second: { type: 'EXTRACT', value: 'SECOND' },
  $millisecond: { type: 'TO_CHAR', value: 'FF3' }, // milliseconds
  $month: { type: 'EXTRACT', value: 'MONTH' },
  $week: { type: 'TO_CHAR', value: 'IW' }, // ISO week
  $year: { type: 'EXTRACT', value: 'YEAR' },
};

const toOracleValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      return value.iso;
    }
    if (value.__type === 'File') {
      return value.name;
    }
  }
  return value;
};

// Get Oracle cast type for a value (used in dot notation comparisons)
const toOracleValueCastType = value => {
  const oracleValue = toOracleValue(value);
  switch (typeof oracleValue) {
    case 'number':
      return 'NUMBER';
    case 'boolean':
      return 'NUMBER'; // Oracle doesn't have boolean, use NUMBER(1)
    default:
      return undefined;
  }
};

const transformValue = value => {
  if (typeof value === 'object' && value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
};

const ensureStringFits = (fieldName: string, value: any) => {
  if (typeof value === 'string' && value.length > ORACLE_VARCHAR_MAX) {
    throw new Parse.Error(
      Parse.Error.INVALID_JSON,
      `Field ${fieldName} exceeds Oracle VARCHAR2(${ORACLE_VARCHAR_MAX}) limit`
    );
  }
};

const normalizeQueryValue = (value: any) => {
  if (value && value.__type === 'Date') {
    return toOracleValue(value);
  }
  if (value && value.__type === 'File') {
    return toOracleValue(value);
  }
  return transformValue(value);
};

// Convert boolean to Oracle NUMBER(1)
const toOracleBoolean = value => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
};

// Convert Oracle NUMBER(1) to boolean
const fromOracleBoolean = value => {
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
};

// Duplicate from the mongo adapter...
const emptyCLPS = Object.freeze({
  find: {},
  get: {},
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
  protectedFields: {},
});

const defaultCLPS = Object.freeze({
  find: { '*': true },
  get: { '*': true },
  count: { '*': true },
  create: { '*': true },
  update: { '*': true },
  delete: { '*': true },
  addField: { '*': true },
  protectedFields: { '*': [] },
});

const toParseSchema = schema => {
  if (schema.className === '_User') {
    delete schema.fields._hashed_password;
  }
  if (schema.fields) {
    delete schema.fields._wperm;
    delete schema.fields._rperm;
  }
  let clps = defaultCLPS;
  if (schema.classLevelPermissions) {
    clps = { ...emptyCLPS, ...schema.classLevelPermissions };
  }
  let indexes = {};
  if (schema.indexes) {
    indexes = { ...schema.indexes };
  }
  return {
    className: schema.className,
    fields: schema.fields,
    classLevelPermissions: clps,
    indexes,
  };
};

const toOracleSchema = schema => {
  if (!schema) {
    return schema;
  }
  schema.fields = schema.fields || {};
  schema.fields._wperm = { type: 'Array', contents: { type: 'String' } };
  schema.fields._rperm = { type: 'Array', contents: { type: 'String' } };
  if (schema.className === '_User') {
    schema.fields._hashed_password = { type: 'String' };
    schema.fields._password_history = { type: 'Array' };
  }
  return schema;
};

const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      /* eslint-disable no-cond-assign */
      while ((next = components.shift())) {
        /* eslint-enable no-cond-assign */
        currentObj[next] = currentObj[next] || {};
        if (components.length === 0) {
          currentObj[next] = value;
        }
        currentObj = currentObj[next];
      }
      delete object[fieldName];
    }
  });
  return object;
};

const validateKeys = object => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }

      if (key.includes('$') || key.includes('.')) {
        throw new Parse.Error(
          Parse.Error.INVALID_NESTED_KEY,
          "Nested keys should not contain the '$' or '.' characters"
        );
      }
    }
  }
};

// Returns the list of join tables on a schema
const joinTablesForSchema = schema => {
  const list = [];
  if (schema) {
    Object.keys(schema.fields).forEach(field => {
      if (schema.fields[field].type === 'Relation') {
        list.push(`_Join:${field}:${schema.className}`);
      }
    });
  }
  return list;
};

// Quote identifier for Oracle (preserves case)
const quoteIdentifier = name => {
  // Oracle identifiers are limited to 128 characters in 12.2+
  // Escape any double quotes in the name
  return `"${name.replace(/"/g, '""')}"`;
};

// Check if a string is an array index (all digits)
const isArrayIndex = (str) => /^\d+$/.test(str);

// Transform dot notation field to components for JSON access
// e.g., "a.b.c" -> ['"a"', "'b'", "'c'"]
const transformDotFieldToComponents = fieldName => {
  if (!fieldName || typeof fieldName !== 'string') {
    return [quoteIdentifier(fieldName || '')];
  }
  return fieldName.split('.').map((cmpt, index) => {
    if (index === 0) {
      return quoteIdentifier(cmpt);
    }
    if (isArrayIndex(cmpt)) {
      return Number(cmpt);
    } else {
      return `'${cmpt}'`;
    }
  });
};

// Transform dot field to Oracle JSON path expression
// For queries like "data.nested.field" -> JSON_VALUE("data", '$.nested.field')
const transformDotFieldForOracle = fieldName => {
  if (!fieldName || typeof fieldName !== 'string') {
    return quoteIdentifier(fieldName || '');
  }
  if (fieldName.indexOf('.') === -1) {
    return quoteIdentifier(fieldName);
  }
  const components = fieldName.split('.');
  const column = components[0];
  const path = '$.' + components.slice(1).join('.');
  return { column: quoteIdentifier(column), path };
};

// Build JSON_VALUE expression for dot notation
const buildJsonValueExpr = (fieldName, paramName) => {
  const dotInfo = transformDotFieldForOracle(fieldName);
  if (typeof dotInfo === 'string') {
    return { expr: `${dotInfo} = :${paramName}`, isDot: false };
  }
  return {
    expr: `JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') = :${paramName}`,
    isDot: true,
    column: dotInfo.column,
    path: dotInfo.path
  };
};

// Helper functions for regex pattern detection (from PostgreSQL adapter)
function isStartsWithRegex(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('^')) {
    return false;
  }
  const matches = value.match(/\^\\Q.*\\E/);
  return !!matches;
}

function isAllValuesRegexOrNone(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }
  const firstValuesIsRegex = isStartsWithRegex(values[0].$regex);
  if (values.length === 1) {
    return firstValuesIsRegex;
  }
  for (let i = 1, length = values.length; i < length; ++i) {
    if (firstValuesIsRegex !== isStartsWithRegex(values[i].$regex)) {
      return false;
    }
  }
  return true;
}

function isAnyValueRegexStartsWith(values) {
  return values.some(function (value) {
    return isStartsWithRegex(value.$regex);
  });
}

function processRegexPattern(s) {
  if (s && s.startsWith('^')) {
    return '^' + literalizeRegexPart(s.slice(1));
  } else if (s && s.endsWith('$')) {
    return literalizeRegexPart(s.slice(0, s.length - 1)) + '$';
  }
  return literalizeRegexPart(s);
}

function literalizeRegexPart(s) {
  if (!s) return s;
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);
  if (result1 && result1.length > 1 && result1.index > -1) {
    const prefix = s.substring(0, result1.index);
    const remaining = result1[1];
    return literalizeRegexPart(prefix) + remaining;
  }
  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);
  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substring(0, result2.index);
    const remaining = result2[1];
    return literalizeRegexPart(prefix) + remaining;
  }
  return s
    .replace(/([^\\])(\\E)/, '$1')
    .replace(/([^\\])(\\Q)/, '$1')
    .replace(/^\\E/, '')
    .replace(/^\\Q/, '');
}

// Build JSON_EXISTS expression to check if a path exists
const buildJsonExistsExpr = (fieldName, exists) => {
  const dotInfo = transformDotFieldForOracle(fieldName);
  if (typeof dotInfo === 'string') {
    return exists ? `${dotInfo} IS NOT NULL` : `${dotInfo} IS NULL`;
  }
  if (exists) {
    return `JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`;
  } else {
    return `NOT JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`;
  }
};

interface WhereClause {
  pattern: string;
  values: Object;
  sorts: Array<any>;
}

// Build WHERE clause for Oracle
// Oracle uses named bind variables (:param) instead of positional ($1)
const buildWhereClause = ({ schema, query, index, caseInsensitive }): WhereClause => {
  const patterns = [];
  const values = {};
  const sorts = [];

  schema = toOracleSchema(schema);
  for (const fieldName in query) {
    if (fieldName === '$text') {
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        'Oracle adapter does not support $text search; use $regex or add Oracle Text in Milestone 3.'
      );
    }

    const isArrayField =
      schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName];

    // nothing in the schema, it's gonna blow up
    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }

    const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
    if (authDataMatch) {
      // TODO: Handle querying by _auth_data_provider, authData is stored in authData field
      continue;
    } else if (caseInsensitive && (fieldName === 'username' || fieldName === 'email')) {
      patterns.push(`LOWER(${quoteIdentifier(fieldName)}) = LOWER(:v${index})`);
      values[`v${index}`] = fieldValue;
      index += 1;
    } else if (fieldName.indexOf('.') >= 0) {
      // Dot notation field - use JSON_VALUE for querying nested fields
      const dotInfo = transformDotFieldForOracle(fieldName);
      if (fieldValue === null) {
        patterns.push(`NOT JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`);
        continue;
      } else if (fieldValue.$in) {
        // Handle $in for dot notation
        const inParams = fieldValue.$in.map((val, i) => {
          const paramName = `v${index + i}`;
          values[paramName] = typeof val === 'object' ? JSON.stringify(val) : val;
          return `:${paramName}`;
        });
        patterns.push(`JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') IN (${inParams.join(', ')})`);
        index += fieldValue.$in.length;
      } else if (fieldValue.$regex) {
        let flags = '';
        const opts = fieldValue.$options;
        if (opts && opts.indexOf('i') >= 0) {
          flags = 'i';
        }
        patterns.push(
          `REGEXP_LIKE(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}'), :v${index}${flags ? `, '${flags}'` : ''})`
        );
        values[`v${index}`] = fieldValue.$regex;
        index += 1;
      } else if (fieldValue.$exists !== undefined) {
        if (fieldValue.$exists) {
          patterns.push(`JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`);
        } else {
          patterns.push(`NOT JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`);
        }
      } else if (fieldValue.$ne !== undefined) {
        const neValue = fieldValue.$ne;
        if (neValue === null) {
          patterns.push(`JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`);
        } else {
          patterns.push(`(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') <> :v${index} OR NOT JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}'))`);
          values[`v${index}`] = typeof neValue === 'object' ? JSON.stringify(neValue) : neValue;
          index += 1;
        }
      } else if (fieldValue.$gt !== undefined || fieldValue.$lt !== undefined ||
                 fieldValue.$gte !== undefined || fieldValue.$lte !== undefined) {
        // Handle comparison operators for dot notation
        Object.keys(ParseToOracleComparator).forEach(cmp => {
          if (fieldValue[cmp] !== undefined) {
            const cmpValue = toOracleValue(fieldValue[cmp]);
            const castType = toOracleValueCastType(fieldValue[cmp]);
            // Use appropriate casting based on value type
            const jsonExpr = castType
              ? `CAST(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') AS ${castType})`
              : `JSON_VALUE(${dotInfo.column}, '${dotInfo.path}')`;
            patterns.push(`${jsonExpr} ${ParseToOracleComparator[cmp]} :v${index}`);
            values[`v${index}`] = cmpValue;
            index += 1;
          }
        });
      } else if (fieldValue.$eq !== undefined) {
        // Handle $eq for dot notation
        const eqValue = fieldValue.$eq;
        if (eqValue === null) {
          patterns.push(`NOT JSON_EXISTS(${dotInfo.column}, '${dotInfo.path}')`);
        } else {
          const castType = toOracleValueCastType(eqValue);
          const jsonExpr = castType
            ? `CAST(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') AS ${castType})`
            : `JSON_VALUE(${dotInfo.column}, '${dotInfo.path}')`;
          patterns.push(`${jsonExpr} = :v${index}`);
          values[`v${index}`] = typeof eqValue === 'object' ? JSON.stringify(eqValue) : eqValue;
          index += 1;
        }
      } else if (typeof fieldValue !== 'object') {
        patterns.push(`JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') = :v${index}`);
        values[`v${index}`] = fieldValue;
        index += 1;
      }
    } else if (fieldValue === null || fieldValue === undefined) {
      patterns.push(`${quoteIdentifier(fieldName)} IS NULL`);
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
      values[`v${index}`] = fieldValue;
      index += 1;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
      // Convert boolean to Oracle NUMBER(1)
      if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Number') {
        // Should always return zero results
        const MAX_INT_PLUS_ONE = 9223372036854775808;
        values[`v${index}`] = MAX_INT_PLUS_ONE;
      } else {
        values[`v${index}`] = toOracleBoolean(fieldValue);
      }
      index += 1;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
      values[`v${index}`] = fieldValue;
      index += 1;
    } else if (['$or', '$nor', '$and'].includes(fieldName)) {
      const clauses = [];
      fieldValue.forEach(subQuery => {
        const clause = buildWhereClause({
          schema,
          query: subQuery,
          index,
          caseInsensitive,
        });
        if (clause.pattern.length > 0) {
          clauses.push(clause.pattern);
          Object.assign(values, clause.values);
          index += Object.keys(clause.values).length;
        }
      });

      const orOrAnd = fieldName === '$and' ? ' AND ' : ' OR ';
      const not = fieldName === '$nor' ? ' NOT ' : '';

      patterns.push(`${not}(${clauses.join(orOrAnd)})`);
    }

    // Handle $ne for non-dot-notation fields (dot notation $ne is handled above)
    if (fieldValue.$ne !== undefined && fieldName.indexOf('.') === -1) {
      if (fieldValue.$ne === null) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NOT NULL`);
      } else {
        patterns.push(`(${quoteIdentifier(fieldName)} <> :v${index} OR ${quoteIdentifier(fieldName)} IS NULL)`);
        let neValue = fieldValue.$ne;
        if (neValue && neValue.$relativeTime) {
          if (schema.fields[fieldName].type !== 'Date') {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              '$relativeTime can only be used with Date field'
            );
          }
          const parserResult = Utils.relativeTimeToDate(neValue.$relativeTime);
          if (parserResult.status !== 'success') {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              `bad $relativeTime (${neValue.$relativeTime}) value. ${parserResult.info}`
            );
          }
          neValue = toOracleValue(parserResult.result);
        }
        values[`v${index}`] = normalizeQueryValue(neValue);
        index += 1;
      }
    }

    // Handle $eq for non-dot-notation fields
    if (fieldValue.$eq !== undefined && fieldName.indexOf('.') === -1) {
      if (fieldValue.$eq === null) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NULL`);
      } else {
        patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
        let eqValue = fieldValue.$eq;
        if (eqValue && eqValue.$relativeTime) {
          if (schema.fields[fieldName].type !== 'Date') {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              '$relativeTime can only be used with Date field'
            );
          }
          const parserResult = Utils.relativeTimeToDate(eqValue.$relativeTime);
          if (parserResult.status !== 'success') {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              `bad $relativeTime (${eqValue.$relativeTime}) value. ${parserResult.info}`
            );
          }
          eqValue = toOracleValue(parserResult.result);
        }
        values[`v${index}`] = normalizeQueryValue(eqValue);
        index += 1;
      }
    }

    // Handle $in and $nin for non-dot-notation fields (dot notation is handled above)
    if (Array.isArray(fieldValue.$in) && fieldName.indexOf('.') === -1) {
      if (fieldValue.$in.length === 0) {
        patterns.push('1 = 0'); // Return no values
      } else if (isArrayField) {
        // For array fields, use stored function to check if any element is in the array
        const inValues = JSON.stringify(fieldValue.$in);
        patterns.push(`parse_array_contains(${quoteIdentifier(fieldName)}, :v${index}) = 1`);
        values[`v${index}`] = inValues;
        index += 1;
      } else {
        const inParams = fieldValue.$in.map((val, i) => {
          const paramName = `v${index + i}`;
          values[paramName] = normalizeQueryValue(val);
          return `:${paramName}`;
        });
        patterns.push(`${quoteIdentifier(fieldName)} IN (${inParams.join(', ')})`);
        index += fieldValue.$in.length;
      }
    }

    if (Array.isArray(fieldValue.$nin) && fieldName.indexOf('.') === -1) {
      if (fieldValue.$nin.length === 0) {
        patterns.push('1 = 1'); // Return all values
      } else if (isArrayField) {
        // For array fields, use stored function to check if no element is in the array
        const ninValues = JSON.stringify(fieldValue.$nin);
        patterns.push(`parse_array_contains(${quoteIdentifier(fieldName)}, :v${index}) = 0`);
        values[`v${index}`] = ninValues;
        index += 1;
      } else {
        const ninParams = fieldValue.$nin.map((val, i) => {
          const paramName = `v${index + i}`;
          values[paramName] = normalizeQueryValue(val);
          return `:${paramName}`;
        });
        patterns.push(`${quoteIdentifier(fieldName)} NOT IN (${ninParams.join(', ')})`);
        index += fieldValue.$nin.length;
      }
    }

    // Handle $all - array must contain all specified values
    if (Array.isArray(fieldValue.$all) && isArrayField) {
      if (fieldValue.$all.length === 0) {
        patterns.push('1 = 0'); // Empty $all never matches
      } else if (isAnyValueRegexStartsWith(fieldValue.$all)) {
        // Handle regex pattern matching for $all
        if (!isAllValuesRegexOrNone(fieldValue.$all)) {
          throw new Parse.Error(
            Parse.Error.INVALID_JSON,
            'All $all values must be of regex type or none: ' + fieldValue.$all
          );
        }
        // Process regex patterns - convert ^\\Q...\\E to pattern%
        const processedValues = fieldValue.$all.map(item => {
          const value = processRegexPattern(item.$regex);
          return value.substring(1) + '%'; // Remove ^ and add %
        });
        patterns.push(`parse_array_contains_all_regex(${quoteIdentifier(fieldName)}, :v${index}) = 1`);
        values[`v${index}`] = JSON.stringify(processedValues);
        index += 1;
      } else {
        // Use stored function to check that all values exist in the array
        const allValues = JSON.stringify(fieldValue.$all);
        patterns.push(`parse_array_contains_all(${quoteIdentifier(fieldName)}, :v${index}) = 1`);
        values[`v${index}`] = allValues;
        index += 1;
      }
    } else if (Array.isArray(fieldValue.$all)) {
      // Handle non-array field $all (for pointer arrays)
      if (fieldValue.$all.length === 1) {
        patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
        values[`v${index}`] = fieldValue.$all[0].objectId;
        index += 1;
      }
    }

    // Handle $containedBy - array must be a subset of specified values
    if (fieldValue.$containedBy && isArrayField) {
      const arr = fieldValue.$containedBy;
      if (!(arr instanceof Array)) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, `bad $containedBy: should be an array`);
      }
      if (arr.length === 0) {
        // Only empty arrays are contained by empty array
        patterns.push(`(${quoteIdentifier(fieldName)} IS NULL OR JSON_QUERY(${quoteIdentifier(fieldName)}, '$') = '[]')`);
      } else {
        // All elements in the field must be in the containedBy array
        // Using NOT EXISTS with inline SQL as containedBy is less common
        const containedByValues = JSON.stringify(arr);
        patterns.push(`NOT EXISTS (
          SELECT 1 FROM JSON_TABLE(${quoteIdentifier(fieldName)}, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
          WHERE jt.val NOT IN (SELECT jv.val FROM JSON_TABLE(:v${index}, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jv)
        )`);
        values[`v${index}`] = containedByValues;
        index += 1;
      }
    }

    // Handle $exists for non-dot-notation fields (dot notation is handled above)
    if (typeof fieldValue.$exists !== 'undefined' && fieldName.indexOf('.') === -1) {
      if (fieldValue.$exists) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NOT NULL`);
      } else {
        patterns.push(`${quoteIdentifier(fieldName)} IS NULL`);
      }
    }

    // Handle $regex for non-dot-notation fields (dot notation is handled above)
    if (fieldValue.$regex && fieldName.indexOf('.') === -1) {
      // Oracle uses REGEXP_LIKE for regex matching
      let regex = fieldValue.$regex;
      let flags = '';
      const opts = fieldValue.$options;
      if (opts) {
        if (opts.indexOf('i') >= 0) {
          flags = 'i'; // case insensitive
        }
      }
      patterns.push(`REGEXP_LIKE(${quoteIdentifier(fieldName)}, :v${index}${flags ? `, '${flags}'` : ''})`);
      values[`v${index}`] = regex;
      index += 1;
    }

    // Handle $text - full-text search is not supported in Oracle adapter
    // Fail gracefully with a clear error message
    if (fieldValue.$text) {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        '$text search is not supported in the Oracle adapter. Consider using $regex for pattern matching, or implement Oracle Text for full-text search capabilities.'
      );
    }

    if (fieldValue.__type === 'Pointer') {
      patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
      values[`v${index}`] = fieldValue.objectId;
      index += 1;
    }

    if (fieldValue.__type === 'Date') {
      patterns.push(`${quoteIdentifier(fieldName)} = TO_TIMESTAMP_TZ(:v${index}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`);
      values[`v${index}`] = fieldValue.iso;
      index += 1;
    }

    if (fieldValue.__type === 'GeoPoint') {
      patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
      values[`v${index}`] = JSON.stringify(fieldValue);
      index += 1;
    }

    // GeoPoint queries: $nearSphere, $geoWithin
    // GeoPoints are stored as JSON: {"latitude": x, "longitude": y}
    const isGeoPointField =
      schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'GeoPoint';

    if (fieldValue.$nearSphere && isGeoPointField) {
      const point = fieldValue.$nearSphere;
      const lat = point.latitude;
      const lon = point.longitude;
      const col = quoteIdentifier(fieldName);

      // Haversine formula for great-circle distance in radians
      // Earth's radius is 6371 km, but Parse uses radians for $maxDistance
      // 1 radian = 6371 km
      const haversineExpr = `(
        2 * ASIN(SQRT(
          POWER(SIN((TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) - :lat${index}) * 3.14159265359 / 180 / 2), 2) +
          COS(:lat${index} * 3.14159265359 / 180) *
          COS(TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) * 3.14159265359 / 180) *
          POWER(SIN((TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) - :lon${index}) * 3.14159265359 / 180 / 2), 2)
        ))
      )`;

      values[`lat${index}`] = lat;
      values[`lon${index}`] = lon;

      if (fieldValue.$maxDistance !== undefined) {
        // $maxDistance is in radians
        patterns.push(`${haversineExpr} <= :maxDist${index}`);
        values[`maxDist${index}`] = fieldValue.$maxDistance;
      } else {
        // Just ensure the field is not null for nearSphere without maxDistance
        patterns.push(`${col} IS NOT NULL`);
      }

      // Add distance to sorts for ordering by proximity
      sorts.push({
        field: fieldName,
        direction: 'ASC',
        distanceExpr: haversineExpr,
      });
      index += 1;
    }

    // Legacy $within.$box support (same as $geoWithin.$box)
    if (fieldValue.$within && fieldValue.$within.$box && isGeoPointField) {
      const col = quoteIdentifier(fieldName);
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;

      patterns.push(`(
        TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) >= :boxBottom${index} AND
        TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) <= :boxTop${index} AND
        TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) >= :boxLeft${index} AND
        TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) <= :boxRight${index}
      )`);
      values[`boxBottom${index}`] = bottom;
      values[`boxTop${index}`] = top;
      values[`boxLeft${index}`] = left;
      values[`boxRight${index}`] = right;
      index += 1;
    }

    if (fieldValue.$geoWithin && isGeoPointField) {
      const col = quoteIdentifier(fieldName);

      // $geoWithin.$box - rectangular bounding box
      if (fieldValue.$geoWithin.$box) {
        const box = fieldValue.$geoWithin.$box;
        const southwest = box[0]; // {latitude, longitude}
        const northeast = box[1];

        patterns.push(`(
          TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) >= :swLat${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) <= :neLat${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) >= :swLon${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) <= :neLon${index}
        )`);
        values[`swLat${index}`] = southwest.latitude;
        values[`swLon${index}`] = southwest.longitude;
        values[`neLat${index}`] = northeast.latitude;
        values[`neLon${index}`] = northeast.longitude;
        index += 1;
      }

      // $geoWithin.$centerSphere - circle defined by center and radius in radians
      if (fieldValue.$geoWithin.$centerSphere) {
        const center = fieldValue.$geoWithin.$centerSphere[0]; // [longitude, latitude] or {latitude, longitude}
        const radius = fieldValue.$geoWithin.$centerSphere[1]; // radius in radians

        // Handle both array format [lon, lat] and object format
        const lat = Array.isArray(center) ? center[1] : center.latitude;
        const lon = Array.isArray(center) ? center[0] : center.longitude;

        // Haversine distance must be <= radius
        const haversineExpr = `(
          2 * ASIN(SQRT(
            POWER(SIN((TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) - :cLat${index}) * 3.14159265359 / 180 / 2), 2) +
            COS(:cLat${index} * 3.14159265359 / 180) *
            COS(TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) * 3.14159265359 / 180) *
            POWER(SIN((TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) - :cLon${index}) * 3.14159265359 / 180 / 2), 2)
          ))
        )`;

        patterns.push(`${haversineExpr} <= :cRadius${index}`);
        values[`cLat${index}`] = lat;
        values[`cLon${index}`] = lon;
        values[`cRadius${index}`] = radius;
        index += 1;
      }

      // $geoWithin.$polygon - polygon defined by array of points
      if (fieldValue.$geoWithin.$polygon) {
        const polygon = fieldValue.$geoWithin.$polygon;
        // Point-in-polygon using ray casting algorithm is complex in SQL
        // For Milestone 2, we'll use a bounding box approximation
        // Full polygon support would require Oracle Spatial or complex PL/SQL

        // Calculate bounding box from polygon points
        const lats = polygon.map(p => p.latitude);
        const lons = polygon.map(p => p.longitude);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);

        patterns.push(`(
          TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) >= :polyMinLat${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.latitude')) <= :polyMaxLat${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) >= :polyMinLon${index} AND
          TO_NUMBER(JSON_VALUE(${col}, '$.longitude')) <= :polyMaxLon${index}
        )`);
        values[`polyMinLat${index}`] = minLat;
        values[`polyMaxLat${index}`] = maxLat;
        values[`polyMinLon${index}`] = minLon;
        values[`polyMaxLon${index}`] = maxLon;
        index += 1;
      }
    }

    // $geoIntersects.$point - check if a polygon contains a point
    // For Polygon type fields
    const isPolygonField =
      schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Polygon';

    if (fieldValue.$geoIntersects && fieldValue.$geoIntersects.$point && isPolygonField) {
      const point = fieldValue.$geoIntersects.$point;
      if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
        throw new Parse.Error(
          Parse.Error.INVALID_JSON,
          'bad $geoIntersects value; $point should be GeoPoint'
        );
      }
      Parse.GeoPoint._validate(point.latitude, point.longitude);

      const col = quoteIdentifier(fieldName);
      // For Polygon stored as JSON, we use bounding box approximation
      // Full point-in-polygon would require Oracle Spatial (SDO_GEOMETRY)
      // The polygon JSON structure has coordinates array

      // Check if point is within the polygon's bounding box
      // Extract min/max from the polygon coordinates stored in JSON
      patterns.push(`(
        :ptLat${index} >= (
          SELECT MIN(TO_NUMBER(JSON_VALUE(coords.val, '$[1]')))
          FROM JSON_TABLE(JSON_QUERY(${col}, '$.coordinates'), '$[*]' COLUMNS (val CLOB PATH '$')) coords
        ) AND
        :ptLat${index} <= (
          SELECT MAX(TO_NUMBER(JSON_VALUE(coords.val, '$[1]')))
          FROM JSON_TABLE(JSON_QUERY(${col}, '$.coordinates'), '$[*]' COLUMNS (val CLOB PATH '$')) coords
        ) AND
        :ptLon${index} >= (
          SELECT MIN(TO_NUMBER(JSON_VALUE(coords.val, '$[0]')))
          FROM JSON_TABLE(JSON_QUERY(${col}, '$.coordinates'), '$[*]' COLUMNS (val CLOB PATH '$')) coords
        ) AND
        :ptLon${index} <= (
          SELECT MAX(TO_NUMBER(JSON_VALUE(coords.val, '$[0]')))
          FROM JSON_TABLE(JSON_QUERY(${col}, '$.coordinates'), '$[*]' COLUMNS (val CLOB PATH '$')) coords
        )
      )`);
      values[`ptLat${index}`] = point.latitude;
      values[`ptLon${index}`] = point.longitude;
      index += 1;
    }

    // Comparison operators ($gt, $lt, $gte, $lte)
    Object.keys(ParseToOracleComparator).forEach(cmp => {
      if (fieldValue[cmp] || fieldValue[cmp] === 0) {
        const oracleComparator = ParseToOracleComparator[cmp];
        let oracleValue = toOracleValue(fieldValue[cmp]);

        if (typeof oracleValue === 'object' && oracleValue.$relativeTime) {
          if (schema.fields[fieldName].type !== 'Date') {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              '$relativeTime can only be used with Date field'
            );
          }
          const parserResult = Utils.relativeTimeToDate(oracleValue.$relativeTime);
          if (parserResult.status === 'success') {
            oracleValue = toOracleValue(parserResult.result);
          } else {
            throw new Parse.Error(
              Parse.Error.INVALID_JSON,
              `bad $relativeTime (${oracleValue.$relativeTime}) value. ${parserResult.info}`
            );
          }
        }

        patterns.push(`${quoteIdentifier(fieldName)} ${oracleComparator} :v${index}`);
        values[`v${index}`] = oracleValue;
        index += 1;
      }
    });

    if (initialPatternsLength === patterns.length) {
      // Check if we have a complex query type that's not yet supported
      if (fieldValue && typeof fieldValue === 'object' && !fieldValue.__type) {
        const unsupportedOps = Object.keys(fieldValue).filter(k => k.startsWith('$'));
        if (unsupportedOps.length > 0) {
          throw new Parse.Error(
            Parse.Error.OPERATION_FORBIDDEN,
            `Oracle doesn't support this query type yet: ${JSON.stringify(fieldValue)}`
          );
        }
      }
    }
  }

  return { pattern: patterns.join(' AND '), values, sorts };
};

export class OracleStorageAdapter implements StorageAdapter {
  canSortOnJoinTables: boolean;
  enableSchemaHooks: boolean;

  // Private
  _collectionPrefix: string;
  _pool: any;
  _oracledb: any;
  _onchange: any;
  _uuid: any;
  schemaCacheTtl: ?number;
  _uri: string;
  _databaseOptions: any;
  _initialized: boolean;

  constructor({ uri, collectionPrefix = '', databaseOptions = {} }: any) {
    this._collectionPrefix = collectionPrefix;
    this.enableSchemaHooks = !!databaseOptions.enableSchemaHooks;
    this.schemaCacheTtl = databaseOptions.schemaCacheTtl;
    this._uri = uri;
    this._databaseOptions = databaseOptions;
    this._onchange = () => {};
    this._uuid = uuidv4();
    this.canSortOnJoinTables = false;
    this._initialized = false;
  }

  async _ensureConnection() {
    if (!this._initialized) {
      const options = { ...this._databaseOptions };
      for (const key of ['enableSchemaHooks', 'schemaCacheTtl']) {
        delete options[key];
      }
      const { pool, oracledb } = await createClient(this._uri, options);
      this._pool = pool;
      this._oracledb = oracledb;
      this._initialized = true;
    }
  }

  async _getConnection() {
    await this._ensureConnection();
    return this._pool.getConnection();
  }

  watch(callback: () => void): void {
    this._onchange = callback;
  }

  createExplainableQuery(query: string, analyze: boolean = false) {
    // Oracle uses EXPLAIN PLAN FOR
    return 'EXPLAIN PLAN FOR ' + query;
  }

  handleShutdown() {
    if (!this._pool) {
      return;
    }
    // Close the pool - Oracle's close is async, but we call it synchronously
    // to match PostgreSQL's interface. The pool will drain in the background.
    this._pool.close(0).catch(error => {
      console.error('Error closing Oracle pool:', error);
    });
    this._pool = null;
    this._initialized = false;
  }

  _notifySchemaChange() {
    // Schema change notification - simplified for now
    // Oracle doesn't have LISTEN/NOTIFY like PostgreSQL
    // Could implement using AQ (Advanced Queuing) in the future
    this._onchange();
  }

  // Helper to apply collection prefix to className (like MongoDB's _adaptiveCollection)
  _prefixTableName(className: string): string {
    return this._collectionPrefix + className;
  }

  async _ensureSchemaCollectionExists(conn: any) {
    conn = conn || (await this._getConnection());
    const shouldRelease = !arguments[0];
    try {
      // Check if _SCHEMA table exists
      const result = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM user_tables WHERE table_name = '_SCHEMA'`
      );

      if (result.rows[0].CNT === 0) {
        await conn.execute(`
          CREATE TABLE "_SCHEMA" (
            "className" VARCHAR2(120) PRIMARY KEY,
            "schema" CLOB,
            "isParseClass" NUMBER(1)
          )
        `);
        await conn.commit();
      }
    } catch (error) {
      if (error.errorNum !== OracleDuplicateTableError) {
        throw error;
      }
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async classExists(name: string) {
    const conn = await this._getConnection();
    try {
      const prefixedName = this._prefixTableName(name);
      const result = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM user_tables WHERE table_name = :prefixedName`,
        { prefixedName }
      );
      return result.rows[0].CNT > 0;
    } finally {
      await conn.close();
    }
  }

  async setClassLevelPermissions(className: string, CLPs: any) {
    const conn = await this._getConnection();
    try {
      // Get current schema
      const result = await conn.execute(
        `SELECT "schema" FROM "_SCHEMA" WHERE "className" = :className`,
        { className }
      );

      if (result.rows.length > 0) {
        // Handle CLOB
        let schemaData = result.rows[0].schema;
        if (schemaData && typeof schemaData === 'object' && schemaData.constructor.name === 'Lob') {
          schemaData = await schemaData.getData();
        }
        
        let schema = JSON.parse(schemaData);
        schema.classLevelPermissions = CLPs;

        await conn.execute(
          `UPDATE "_SCHEMA" SET "schema" = :schema WHERE "className" = :className`,
          { schema: JSON.stringify(schema), className }
        );
        await conn.commit();
      }
      this._notifySchemaChange();
    } finally {
      await conn.close();
    }
  }

  async setIndexesWithSchemaFormat(
    className: string,
    submittedIndexes: any,
    existingIndexes: any = {},
    fields: any,
    conn: ?any
  ): Promise<void> {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      if (submittedIndexes === undefined) {
        return Promise.resolve();
      }
      if (Object.keys(existingIndexes).length === 0) {
        existingIndexes = { _id_: { _id: 1 } };
      }
      const deletedIndexes = [];
      const insertedIndexes = [];

      Object.keys(submittedIndexes).forEach(name => {
        const field = submittedIndexes[name];
        if (existingIndexes[name] && field.__op !== 'Delete') {
          throw new Parse.Error(Parse.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
        }
        if (!existingIndexes[name] && field.__op === 'Delete') {
          throw new Parse.Error(
            Parse.Error.INVALID_QUERY,
            `Index ${name} does not exist, cannot delete.`
          );
        }
        if (field.__op === 'Delete') {
          deletedIndexes.push(name);
          delete existingIndexes[name];
        } else {
          Object.keys(field).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(fields, key)) {
              throw new Parse.Error(
                Parse.Error.INVALID_QUERY,
                `Field ${key} does not exist, cannot add index.`
              );
            }
          });
          existingIndexes[name] = field;
          insertedIndexes.push({
            key: field,
            name,
          });
        }
      });

      // Create new indexes
      for (const idx of insertedIndexes) {
        const columns = Object.keys(idx.key).map(k => quoteIdentifier(k)).join(', ');
        const indexName = `${className}_${idx.name}`.substring(0, 128);
        try {
          await conn.execute(
            `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(this._prefixTableName(className))} (${columns})`
          );
        } catch (error) {
          if (error.errorNum !== OracleDuplicateTableError) {
            throw error;
          }
        }
      }

      // Drop deleted indexes
      for (const name of deletedIndexes) {
        const indexName = `${className}_${name}`.substring(0, 128);
        try {
          await conn.execute(`DROP INDEX ${quoteIdentifier(indexName)}`);
        } catch (error) {
          // Ignore if index doesn't exist
        }
      }

      // Update schema with new indexes
      await conn.execute(
        `UPDATE "_SCHEMA" SET "schema" =
          JSON_MERGEPATCH("schema", :patch)
         WHERE "className" = :className`,
        {
          patch: JSON.stringify({ indexes: existingIndexes }),
          className
        }
      );
      await conn.commit();
      this._notifySchemaChange();
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async createClass(className: string, schema: SchemaType, conn: ?any) {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      debug('createClass', className, 'schema:', JSON.stringify(schema));
      await this.createTable(className, schema, conn);

      // Insert into _SCHEMA
      debug('Inserting into _SCHEMA for class:', className);
      await conn.execute(
        `INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES (:className, :schema, 1)`,
        { className, schema: JSON.stringify(schema) }
      );
      debug('Schema inserted successfully');

      await this.setIndexesWithSchemaFormat(className, schema.indexes || {}, {}, schema.fields, conn);
      
      // Only commit if we own the connection (not part of a larger transaction)
      if (shouldRelease) {
        await conn.commit();
        debug('createClass committed successfully');
      } else {
        debug('createClass skipping commit (part of larger transaction)');
      }

      return toParseSchema(schema);
    } catch (err) {
      debug('createClass error:', err);
      // Only rollback if we own the connection
      if (shouldRelease) {
        await conn.rollback();
      }
      if (err.errorNum === OracleUniqueConstraintViolation) {
        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }
      throw err;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
    
    // Notify schema change AFTER transaction completes (like PostgreSQL)
    // Only notify if we committed (owned the connection)
    if (shouldRelease) {
      this._notifySchemaChange();
    }
  }

  // Just create a table, do not insert in schema
  async createTable(className: string, schema: SchemaType, conn: any) {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());
    debug('createTable');

    try {
      const columns = [];
      const fields = Object.assign({}, schema.fields);

      if (className === '_User') {
        fields._email_verify_token_expires_at = { type: 'Date' };
        fields._email_verify_token = { type: 'String' };
        fields._account_lockout_expires_at = { type: 'Date' };
        fields._failed_login_count = { type: 'Number' };
        fields._perishable_token = { type: 'String' };
        fields._perishable_token_expires_at = { type: 'Date' };
        fields._password_changed_at = { type: 'Date' };
        fields._password_history = { type: 'Array' };
      }

      const relations = [];
      Object.keys(fields).forEach(fieldName => {
        const parseType = fields[fieldName];
        // Skip when it's a relation - we'll create the tables later
        if (parseType.type === 'Relation') {
          relations.push(fieldName);
          return;
        }
        if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
          parseType.contents = { type: 'String' };
        }
        const oracleType =
          fieldName === 'objectId' ? 'VARCHAR2(120)' : parseTypeToOracleType(parseType);
        columns.push(`${quoteIdentifier(fieldName)} ${oracleType}`);

        if (fieldName === 'objectId') {
          columns.push(`PRIMARY KEY (${quoteIdentifier(fieldName)})`);
        }
      });

      const prefixedClassName = this._prefixTableName(className);
      
      // Oracle doesn't allow creating a table with no columns
      // Add a dummy objectId column if no columns are specified (will be upgraded later)
      if (columns.length === 0) {
        columns.push(`"objectId" VARCHAR2(120)`);
        columns.push(`PRIMARY KEY ("objectId")`);
      }
      
      const createTableSQL = `CREATE TABLE ${quoteIdentifier(prefixedClassName)} (${columns.join(', ')})`;

      try {
        await conn.execute(createTableSQL);
      } catch (error) {
        if (error.errorNum !== OracleDuplicateTableError) {
          throw error;
        }
        // Table already exists, must have been created by a different request
      }

      // Create join tables for relations
      for (const fieldName of relations) {
        const joinTable = `_Join:${fieldName}:${className}`;
        try {
          await conn.execute(`
            CREATE TABLE ${quoteIdentifier(joinTable)} (
              "relatedId" VARCHAR2(120),
              "owningId" VARCHAR2(120),
              PRIMARY KEY ("relatedId", "owningId")
            )
          `);
        } catch (error) {
          if (error.errorNum !== OracleDuplicateTableError) {
            throw error;
          }
        }
      }

      await conn.commit();
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async schemaUpgrade(className: string, schema: SchemaType, conn: any) {
    debug('schemaUpgrade');
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      const prefixedClassName = this._prefixTableName(className);
      
      // Volatile classes should not be saved to _SCHEMA (they're in-memory only)
      const volatileClasses = [
        '_JobStatus',
        '_PushStatus',
        '_Hooks',
        '_GlobalConfig',
        '_GraphQLConfig',
        '_JobSchedule',
        '_Audience',
        '_Idempotency',
      ];
      
      // First, ensure non-volatile classes exist in _SCHEMA
      if (!volatileClasses.includes(className)) {
        const schemaCheck = await conn.execute(
          `SELECT COUNT(*) as cnt FROM "_SCHEMA" WHERE "className" = :className`,
          { className }
        );
        
        if (schemaCheck.rows[0].CNT === 0) {
          // Class not in _SCHEMA, insert it
          debug('schemaUpgrade: Class not in _SCHEMA, inserting:', className);
          await conn.execute(
            `INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES (:className, :schema, 1)`,
            { className, schema: JSON.stringify(schema) }
          );
        }
      }
      
      // Get existing columns
      const result = await conn.execute(
        `SELECT column_name FROM user_tab_columns WHERE table_name = :prefixedClassName`,
        { prefixedClassName }
      );
      const existingColumns = result.rows.map(row => row.COLUMN_NAME);

      // Add missing columns
      for (const fieldName of Object.keys(schema.fields)) {
        if (!existingColumns.includes(fieldName)) {
          await this.addFieldIfNotExists(className, fieldName, schema.fields[fieldName], conn);
        }
      }
      
      // Commit if we own the connection
      if (shouldRelease) {
        await conn.commit();
      }
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
    
    // Notify after transaction
    if (shouldRelease) {
      this._notifySchemaChange();
    }
  }

  async addFieldIfNotExists(className: string, fieldName: string, type: any, conn: ?any) {
    debug('addFieldIfNotExists', className, fieldName, type);
    // If no connection provided, manage our own transaction (like PostgreSQL tx pattern)
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      const prefixedClassName = this._prefixTableName(className);
      
      if (type.type !== 'Relation') {
        const oracleType =
          fieldName === 'objectId' ? 'VARCHAR2(120)' : parseTypeToOracleType(type);
        
        // Helper function to add the column with retry for concurrent DDL errors
        const addColumn = async (retries = 3) => {
          try {
            await conn.execute(
              `ALTER TABLE ${quoteIdentifier(prefixedClassName)} ADD ${quoteIdentifier(fieldName)} ${oracleType}`
            );
          } catch (error) {
            // ORA-14411: DDL cannot be run concurrently - retry with delay
            if (error.errorNum === OracleDDLConcurrentError && retries > 0) {
              debug('DDL concurrent error, retrying:', className, fieldName);
              await new Promise(resolve => setTimeout(resolve, 100 * (4 - retries)));
              return addColumn(retries - 1);
            }
            throw error;
          }
        };
        
        try {
          await addColumn();
        } catch (error) {
          if (error.errorNum === OracleTableDoesNotExistError) {
            debug('Table does not exist, creating class:', className);
            // Table doesn't exist - create it with this field
            // Call createClass WITHOUT conn to let it manage its own transaction
            if (shouldRelease) {
              await conn.close(); // Close our connection first
            }
            try {
              const result = await this.createClass(className, { fields: { [fieldName]: type } });
              return result;
            } catch (createErr) {
              // If createClass fails due to duplicate (race condition), 
              // another call created the class. We need to add our field.
              if (createErr.code === Parse.Error.DUPLICATE_VALUE || 
                  createErr.errorNum === OracleUniqueConstraintViolation) {
                debug('createClass got duplicate, will add field separately');
                // Get a new connection and continue to add the field
                conn = await this._getConnection();
                // Try to add the column again (table now exists) with retry
                try {
                  await addColumn();
                } catch (alterErr) {
                  if (alterErr.errorNum !== OracleDuplicateColumnError) {
                    throw alterErr;
                  }
                  // Column already exists, that's fine
                }
                // Continue to add field to schema below
              } else {
                throw createErr;
              }
            }
          } else if (error.errorNum !== OracleDuplicateColumnError) {
            debug('Error adding field:', error);
            throw error;
          }
          // Column already exists, created by other request - continue to add to schema
        }
      } else {
        // Create join table for relation
        const joinTable = `_Join:${fieldName}:${className}`;
        try {
          await conn.execute(`
            CREATE TABLE ${quoteIdentifier(joinTable)} (
              "relatedId" VARCHAR2(120),
              "owningId" VARCHAR2(120),
              PRIMARY KEY ("relatedId", "owningId")
            )
          `);
        } catch (error) {
          if (error.errorNum !== OracleDuplicateTableError) {
            throw error;
          }
        }
      }

      // Atomically add field to schema using JSON_MERGEPATCH to avoid race conditions
      // when multiple fields are added concurrently (Promise.all in SchemaController)
      // The WHERE clause checks if the field doesn't already exist using JSON_EXISTS
      // Note: JSON path must be a literal in Oracle, so we sanitize and embed the field name
      const fieldPatch = JSON.stringify({ fields: { [fieldName]: type } });
      // Sanitize field name for use in JSON path (allow alphanumeric and underscore)
      const sanitizedFieldName = fieldName.replace(/[^a-zA-Z0-9_]/g, '');
      if (sanitizedFieldName !== fieldName) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}`);
      }
      const updateResult = await conn.execute(
        `UPDATE "_SCHEMA" SET "schema" = JSON_MERGEPATCH("schema", :fieldPatch) 
         WHERE "className" = :className 
         AND NOT JSON_EXISTS("schema", '$.fields.${sanitizedFieldName}')`,
        { fieldPatch, className }
      );
      debug('addFieldIfNotExists: Updated rows:', updateResult.rowsAffected);

      // Only commit if we own the connection (not part of a larger transaction)
      if (shouldRelease) {
        await conn.commit();
      }
    } catch (error) {
      if (shouldRelease) {
        await conn.rollback();
      }
      throw error;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
    
    // Notify schema change AFTER transaction completes (like PostgreSQL)
    if (shouldRelease) {
      this._notifySchemaChange();
    }
  }

  async updateFieldOptions(className: string, fieldName: string, type: any) {
    const conn = await this._getConnection();
    try {
      const result = await conn.execute(
        `SELECT "schema" FROM "_SCHEMA" WHERE "className" = :className`,
        { className }
      );

      if (result.rows.length > 0) {
        // Handle CLOB
        let schemaData = result.rows[0].schema;
        if (schemaData && typeof schemaData === 'object' && schemaData.constructor.name === 'Lob') {
          schemaData = await schemaData.getData();
        }
        
        const schema = JSON.parse(schemaData);
        schema.fields[fieldName] = type;

        await conn.execute(
          `UPDATE "_SCHEMA" SET "schema" = :schema WHERE "className" = :className`,
          { schema: JSON.stringify(schema), className }
        );
        await conn.commit();
      }
    } finally {
      await conn.close();
    }
  }

  // Drops a collection. Resolves with true if it was a Parse Schema
  async deleteClass(className: string) {
    const conn = await this._getConnection();
    try {
      const prefixedClassName = this._prefixTableName(className);
      await conn.execute(`DROP TABLE ${quoteIdentifier(prefixedClassName)}`);
      await conn.execute(
        `DELETE FROM "_SCHEMA" WHERE "className" = :className`,
        { className }
      );
      await conn.commit();
      this._notifySchemaChange();
      return className.indexOf('_Join:') !== 0;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      await conn.close();
    }
  }

  // Delete all data known to this adapter. Used for testing.
  async deleteAllClasses() {
    debug('deleteAllClasses');

    if (!this._pool) {
      return;
    }

    const conn = await this._getConnection();
    try {
      // Get all classes from _SCHEMA
      let results = [];
      try {
        const schemaResult = await conn.execute('SELECT * FROM "_SCHEMA"');
        results = schemaResult.rows;
      } catch (error) {
        if (error.errorNum !== OracleTableDoesNotExistError) {
          throw error;
        }
        return; // No _SCHEMA table, nothing to delete
      }

      // Collect all tables to drop
      const joins = await results.reduce(async (listPromise, schema) => {
        const list = await listPromise;
        // Handle CLOB
        let schemaData = schema.schema;
        if (schemaData && typeof schemaData === 'object' && schemaData.constructor.name === 'Lob') {
          schemaData = await schemaData.getData();
        }
        const schemaObj = typeof schemaData === 'string'
          ? JSON.parse(schemaData)
          : schemaData;
        return list.concat(joinTablesForSchema(schemaObj));
      }, Promise.resolve([]));

      // System tables (no prefix)
      const systemTables = [
        '_SCHEMA',
        '_PushStatus',
        '_JobStatus',
        '_JobSchedule',
        '_Hooks',
        '_GlobalConfig',
        '_GraphQLConfig',
        '_Audience',
        '_Idempotency',
      ];

      // User tables (with prefix) and join tables (no prefix)
      const userTables = results.map(result => this._prefixTableName(result.className));
      const joinTables = joins; // Join tables don't use prefix

      // Drop all tables
      const allTables = [...systemTables, ...userTables, ...joinTables];
      for (const tableName of allTables) {
        try {
          await conn.execute(`DROP TABLE ${quoteIdentifier(tableName)}`);
        } catch (error) {
          if (error.errorNum !== OracleTableDoesNotExistError) {
            throw error;
          }
        }
      }

      await conn.commit();
    } finally {
      await conn.close();
    }
  }

  async deleteFields(className: string, schema: SchemaType, fieldNames: string[]): Promise<void> {
    debug('deleteFields');
    const conn = await this._getConnection();

    try {
      // Filter out relation fields
      const columnsToDelete = fieldNames.filter(fieldName => {
        const field = schema.fields[fieldName];
        return field.type !== 'Relation';
      });

      // Update schema first
      for (const fieldName of fieldNames) {
        delete schema.fields[fieldName];
      }

      await conn.execute(
        `UPDATE "_SCHEMA" SET "schema" = :schema WHERE "className" = :className`,
        { schema: JSON.stringify(schema), className }
      );

      // Drop columns
      const prefixedClassName = this._prefixTableName(className);
      for (const columnName of columnsToDelete) {
        try {
          await conn.execute(
            `ALTER TABLE ${quoteIdentifier(prefixedClassName)} DROP COLUMN ${quoteIdentifier(columnName)}`
          );
        } catch (error) {
          // Ignore if column doesn't exist
        }
      }

      await conn.commit();
      this._notifySchemaChange();
    } finally {
      await conn.close();
    }
  }

  async getAllClasses() {
    const conn = await this._getConnection();
    try {
      const result = await conn.execute('SELECT * FROM "_SCHEMA"');
      debug('getAllClasses: Found', result.rows.length, 'classes');
      
      const classes = await Promise.all(result.rows.map(async row => {
        // Handle CLOB - oracledb returns CLOBs as Lob objects
        let schemaData = row.schema;
        const isLob = schemaData && typeof schemaData === 'object' && schemaData.constructor.name === 'Lob';
        debug('getAllClasses: Processing', row.className, 'isLob:', isLob);
        
        if (isLob) {
          schemaData = await schemaData.getData();
          debug('getAllClasses: CLOB data length:', schemaData?.length);
        }
        
        const schema = typeof schemaData === 'string' ? JSON.parse(schemaData) : schemaData;
        const parseSchema = toParseSchema({ className: row.className, ...schema });
        debug('getAllClasses: Converted', row.className, 'fields:', Object.keys(parseSchema.fields || {}).length);
        return parseSchema;
      }));
      
      debug('getAllClasses: Returning', classes.length, 'classes:', classes.map(c => c.className).join(', '));
      return classes;
    } catch (error) {
      debug('getAllClasses: Error:', error);
      if (error.errorNum === OracleTableDoesNotExistError) {
        return [];
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  async getClass(className: string) {
    debug('getClass');
    const conn = await this._getConnection();
    try {
      const result = await conn.execute(
        `SELECT * FROM "_SCHEMA" WHERE "className" = :className`,
        { className }
      );

      if (result.rows.length !== 1) {
        throw undefined;
      }

      // Handle CLOB - oracledb returns CLOBs as Lob objects by default
      // We configured fetchAsString for CLOBs in OracleClient, but let's be safe
      let schemaData = result.rows[0].schema;
      if (schemaData && typeof schemaData === 'object' && schemaData.constructor.name === 'Lob') {
        // Read CLOB as string
        schemaData = await schemaData.getData();
      }
      
      const schema = typeof schemaData === 'string'
        ? JSON.parse(schemaData)
        : schemaData;
      return toParseSchema(schema);
    } finally {
      await conn.close();
    }
  }

  async createObject(
    className: string,
    schema: SchemaType,
    object: any,
    transactionalSession: ?any
  ) {
    debug('createObject');
    const conn = transactionalSession?.conn || (await this._getConnection());
    const shouldRelease = !transactionalSession;

    schema = toOracleSchema(schema);

    object = handleDotFields(object);
    validateKeys(object);

    const columns = [];
    const values = {};
    const placeholders = [];
    let paramIndex = 0;

    Object.keys(object).forEach(fieldName => {
      if (object[fieldName] === null) {
        return;
      }

      // Handle authData
      const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      const authDataAlreadyExists = !!object.authData;
      if (authDataMatch) {
        const provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        if (authDataAlreadyExists) {
          return;
        }
        fieldName = 'authData';
      }

      columns.push(quoteIdentifier(fieldName));
      const paramName = `p${paramIndex++}`;
      
      // Check if this is a Date field to use proper SQL conversion
      const fieldType = schema.fields[fieldName]?.type;
      const isDateField = fieldType === 'Date' || 
        ['_email_verify_token_expires_at', '_account_lockout_expires_at', 
         '_perishable_token_expires_at', '_password_changed_at',
         'createdAt', 'updatedAt'].includes(fieldName);
      
      if (isDateField) {
        // Use TO_TIMESTAMP_TZ for proper date conversion from ISO format
        placeholders.push(`TO_TIMESTAMP_TZ(:${paramName}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`);
      } else {
        placeholders.push(`:${paramName}`);
      }

      if (!schema.fields[fieldName] && className === '_User') {
        // Handle special _User fields
        if (
          fieldName === '_email_verify_token' ||
          fieldName === '_failed_login_count' ||
          fieldName === '_perishable_token' ||
          fieldName === '_password_history'
        ) {
          ensureStringFits(fieldName, object[fieldName]);
          values[paramName] = typeof object[fieldName] === 'object'
            ? JSON.stringify(object[fieldName])
            : object[fieldName];
        } else if (
          fieldName === '_email_verify_token_expires_at' ||
          fieldName === '_account_lockout_expires_at' ||
          fieldName === '_perishable_token_expires_at' ||
          fieldName === '_password_changed_at'
        ) {
          values[paramName] = object[fieldName] ? object[fieldName].iso : null;
        }
        return;
      }

      switch (fieldType) {
        case 'Date':
          values[paramName] = object[fieldName] ? object[fieldName].iso : null;
          break;
        case 'Pointer':
          values[paramName] = object[fieldName].objectId;
          break;
        case 'Array':
          if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
            values[paramName] = JSON.stringify(object[fieldName]);
          } else {
            values[paramName] = JSON.stringify(object[fieldName]);
          }
          break;
        case 'Object':
        case 'Bytes':
          values[paramName] = JSON.stringify(object[fieldName]);
          break;
        case 'String':
          ensureStringFits(fieldName, object[fieldName]);
          values[paramName] = object[fieldName];
          break;
        case 'Number':
          values[paramName] = object[fieldName];
          break;
        case 'Boolean':
          values[paramName] = toOracleBoolean(object[fieldName]);
          break;
        case 'File':
          ensureStringFits(fieldName, object[fieldName].name);
          values[paramName] = object[fieldName].name;
          break;
        case 'GeoPoint':
          // Store GeoPoint as JSON for now (Milestone 1)
          values[paramName] = JSON.stringify(object[fieldName]);
          break;
        case 'Polygon':
          // Store Polygon as JSON for now (Milestone 1)
          values[paramName] = JSON.stringify(object[fieldName]);
          break;
        default:
          values[paramName] = object[fieldName];
      }
    });

    const prefixedClassName = this._prefixTableName(className);
    const sql = `INSERT INTO ${quoteIdentifier(prefixedClassName)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
    debug('createObject SQL:', sql);
    debug('createObject values:', JSON.stringify(values));

    const promise = (async () => {
      try {
        await conn.execute(sql, values);
        if (!transactionalSession) {
          await conn.commit();
        }
        return { ops: [object] };
      } catch (error) {
        debug('createObject error:', error.errorNum, error.message, error.code);
        if (!transactionalSession) {
          await conn.rollback();
        }
        if (error.errorNum === OracleUniqueConstraintViolation) {
          const err = new Parse.Error(
            Parse.Error.DUPLICATE_VALUE,
            'A duplicate value for a field with unique values was provided'
          );
          err.underlyingError = error;
          if (error.message && typeof error.message === 'string') {
            const matches = error.message.match(/unique.*\(([^)]+)\)/i);
            if (matches && Array.isArray(matches)) {
              err.userInfo = { duplicated_field: matches[1] };
            }
          }
          throw err;
        }
        throw error;
      } finally {
        if (shouldRelease) {
          await conn.close();
        }
      }
    })();

    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  async deleteObjectsByQuery(
    className: string,
    schema: SchemaType,
    query: QueryType,
    transactionalSession: ?any
  ) {
    debug('deleteObjectsByQuery');
    const conn = transactionalSession?.conn || (await this._getConnection());
    const shouldRelease = !transactionalSession;

    const where = buildWhereClause({
      schema,
      query,
      index: 1,
      caseInsensitive: false,
    });

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : 'WHERE 1=1';

    // Oracle doesn't have DELETE ... RETURNING count directly, use a workaround
    const prefixedClassName = this._prefixTableName(className);
    const sql = `DELETE FROM ${quoteIdentifier(prefixedClassName)} ${wherePattern}`;

    const promise = (async () => {
      try {
        const result = await conn.execute(sql, where.values);

        if (!transactionalSession) {
          await conn.commit();
        }

        if (result.rowsAffected === 0) {
          throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }

        return result.rowsAffected;
      } catch (error) {
        if (!transactionalSession) {
          await conn.rollback();
        }
        if (error.errorNum === OracleTableDoesNotExistError) {
          return; // Don't delete anything if table doesn't exist
        }
        throw error;
      } finally {
        if (shouldRelease) {
          await conn.close();
        }
      }
    })();

    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  async findOneAndUpdate(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ): Promise<any> {
    debug('findOneAndUpdate');
    const results = await this.updateObjectsByQuery(className, schema, query, update, transactionalSession);
    return results[0];
  }

  async updateObjectsByQuery(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ): Promise<[any]> {
    debug('updateObjectsByQuery');
    const conn = transactionalSession?.conn || (await this._getConnection());
    const shouldRelease = !transactionalSession;

    schema = toOracleSchema(schema);

    try {
      const updateClauses = [];
      const values = {};
      let paramIndex = 0;

      update = handleDotFields(update);

      // Handle authData first
      for (const fieldName in update) {
        const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
        if (authDataMatch) {
          const provider = authDataMatch[1];
          const value = update[fieldName];
          delete update[fieldName];
          update['authData'] = update['authData'] || {};
          update['authData'][provider] = value;
        }
      }

      for (const fieldName in update) {
        const fieldValue = update[fieldName];

        if (typeof fieldValue === 'undefined') {
          continue;
        } else if (fieldValue === null) {
          updateClauses.push(`${quoteIdentifier(fieldName)} = NULL`);
        } else if (fieldValue.__op === 'Increment') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = COALESCE(${quoteIdentifier(fieldName)}, 0) + :${paramName}`);
          values[paramName] = fieldValue.amount;
        } else if (fieldValue.__op === 'Delete') {
          updateClauses.push(`${quoteIdentifier(fieldName)} = NULL`);
        } else if (fieldName === 'authData') {
          // This recursively sets keys on the JSON object, only 1 level deep
          // Using parse_json_object_set_key function similar to PostgreSQL
          const col = quoteIdentifier(fieldName);
          let updateExpr = `COALESCE(${col}, '{}')`;

          Object.keys(fieldValue).forEach(key => {
            let value = fieldValue[key];
            if (value) {
              if (value.__op === 'Delete') {
                value = null;
              } else {
                value = JSON.stringify(value);
              }
            }
            const keyParam = `authKey${paramIndex}`;
            const valueParam = `authVal${paramIndex}`;
            values[keyParam] = key;
            values[valueParam] = value;
            updateExpr = `parse_json_object_set_key(${updateExpr}, :${keyParam}, :${valueParam})`;
            paramIndex++;
          });

          updateClauses.push(`${col} = ${updateExpr}`);
        } else if (fieldValue.__op === 'Add') {
          // Append objects to existing array using stored function
          const paramName = `u${paramIndex++}`;
          const col = quoteIdentifier(fieldName);
          updateClauses.push(`${col} = parse_array_add(${col}, :${paramName})`);
          values[paramName] = JSON.stringify(fieldValue.objects);
        } else if (fieldValue.__op === 'AddUnique') {
          // Add only unique objects to the array using stored function
          const paramName = `u${paramIndex++}`;
          const col = quoteIdentifier(fieldName);
          updateClauses.push(`${col} = parse_array_add_unique(${col}, :${paramName})`);
          values[paramName] = JSON.stringify(fieldValue.objects);
        } else if (fieldValue.__op === 'Remove') {
          // Remove specified objects from the array using stored function
          const paramName = `u${paramIndex++}`;
          const col = quoteIdentifier(fieldName);
          updateClauses.push(`${col} = parse_array_remove(${col}, :${paramName})`);
          values[paramName] = JSON.stringify(fieldValue.objects)
        } else if (fieldValue.__type === 'Pointer') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = fieldValue.objectId;
        } else if (fieldValue.__type === 'Date') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = TO_TIMESTAMP_TZ(:${paramName}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`);
          values[paramName] = toOracleValue(fieldValue);
        } else if (fieldValue.__type === 'File') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          ensureStringFits(fieldName, toOracleValue(fieldValue));
          values[paramName] = toOracleValue(fieldValue);
        } else if (fieldValue.__type === 'GeoPoint') {
          // Store as JSON for Milestone 1
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = JSON.stringify(fieldValue);
        } else if (fieldValue.__type === 'Polygon') {
          // Store as JSON for Milestone 1
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = JSON.stringify(fieldValue);
        } else if (fieldValue.__type === 'Relation') {
          // noop - relations are handled separately
        } else if (typeof fieldValue === 'object' && schema.fields[fieldName]?.type === 'Object') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = JSON.stringify(fieldValue);
        } else if (Array.isArray(fieldValue) && schema.fields[fieldName]?.type === 'Array') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = JSON.stringify(fieldValue);
        } else if (typeof fieldValue === 'string') {
          const paramName = `u${paramIndex++}`;
          ensureStringFits(fieldName, fieldValue);
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = fieldValue;
        } else if (typeof fieldValue === 'boolean') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = toOracleBoolean(fieldValue);
        } else {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = fieldValue;
        }
      }

      const where = buildWhereClause({
        schema,
        query,
        index: paramIndex + 1,
        caseInsensitive: false,
      });
      Object.assign(values, where.values);

      const whereClause = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
      const prefixedClassName = this._prefixTableName(className);

      // Update and then select the updated rows
      const updateSql = `UPDATE ${quoteIdentifier(prefixedClassName)} SET ${updateClauses.join(', ')} ${whereClause}`;
      await conn.execute(updateSql, values);

      // Fetch the updated rows
      const selectSql = `SELECT * FROM ${quoteIdentifier(prefixedClassName)} ${whereClause}`;
      const result = await conn.execute(selectSql, where.values);

      if (!transactionalSession) {
        await conn.commit();
      }

      return result.rows.map(row => this.oracleObjectToParseObject(className, row, schema));
    } catch (error) {
      if (!transactionalSession) {
        await conn.rollback();
      }
      throw error;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  upsertOneObject(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ) {
    debug('upsertOneObject');
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue, transactionalSession).catch(error => {
      // ignore duplicate value errors as it's upsert
      if (error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      }
      return this.findOneAndUpdate(className, schema, query, update, transactionalSession);
    });
  }

  async find(
    className: string,
    schema: SchemaType,
    query: QueryType,
    { skip, limit, sort, keys, caseInsensitive, explain }: QueryOptions
  ) {
    debug('find');
    const conn = await this._getConnection();

    try {
      schema = toOracleSchema(schema);

      const where = buildWhereClause({
        schema,
        query,
        index: 1,
        caseInsensitive,
      });

      const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';

      // Build ORDER BY clause
      let sortPattern = '';
      // Check for geo distance sorts from $nearSphere
      if (where.sorts && where.sorts.length > 0) {
        const geoSorts = where.sorts.map(s => `${s.distanceExpr} ${s.direction}`);
        sortPattern = `ORDER BY ${geoSorts.join(', ')}`;
      } else if (sort) {
        const sorting = Object.keys(sort)
          .filter(key => key != null && key !== '') // Filter out null/undefined/empty keys
          .map(key => {
            const direction = sort[key] === 1 ? 'ASC' : 'DESC';
            if (key.indexOf('.') >= 0) {
              const dotInfo = transformDotFieldForOracle(key);
              const expr =
                typeof dotInfo === 'string'
                  ? dotInfo
                  : `JSON_VALUE(${dotInfo.column}, '${dotInfo.path}')`;
              return `${expr} ${direction}`;
            }
            return `${quoteIdentifier(key)} ${direction}`;
          })
          .join(', ');
        sortPattern = sorting.length > 0 ? `ORDER BY ${sorting}` : '';
      }

      // Build column selection
      let columns = '*';
      if (keys) {
        keys = keys.filter(key => key != null).reduce((memo, key) => {
          if (key === 'ACL') {
            memo.push('_rperm');
            memo.push('_wperm');
          } else if (
            key.length > 0 &&
            ((schema.fields[key] && schema.fields[key].type !== 'Relation') || key === '$score')
          ) {
            memo.push(key);
          }
          return memo;
        }, []);
        columns = keys.map(key => quoteIdentifier(key)).join(', ');
      }

      // Oracle pagination syntax: OFFSET ... ROWS FETCH NEXT ... ROWS ONLY
      let paginationPattern = '';
      if (skip !== undefined || limit !== undefined) {
        const offsetPart = skip !== undefined ? `OFFSET ${skip} ROWS` : '';
        const limitPart = limit !== undefined ? `FETCH NEXT ${limit} ROWS ONLY` : '';
        paginationPattern = `${offsetPart} ${limitPart}`.trim();
      }

      const prefixedClassName = this._prefixTableName(className);
      const sql = `SELECT ${columns} FROM ${quoteIdentifier(prefixedClassName)} ${wherePattern} ${sortPattern} ${paginationPattern}`;

      if (explain) {
        await conn.execute(this.createExplainableQuery(sql), where.values);
        const plan = await conn.execute(`SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'BASIC'))`);
        return plan.rows;
      }

      const result = await conn.execute(sql, where.values);

      return result.rows.map(row => this.oracleObjectToParseObject(className, row, schema));
    } catch (error) {
      if (error.errorNum === OracleTableDoesNotExistError) {
        return [];
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  // Converts from an Oracle-format object to a REST-format object
  oracleObjectToParseObject(className: string, object: any, schema: any) {
    // Oracle returns column names in uppercase, convert back
    const result = {};
    for (const key in object) {
      // Find the original field name (case-sensitive)
      const fieldName = schema.fields && Object.keys(schema.fields).find(
        f => f.toUpperCase() === key.toUpperCase()
      ) || key;
      result[fieldName] = object[key];
    }
    object = result;

    if (!schema.fields) {
      return object;
    }

    Object.keys(schema.fields).forEach(fieldName => {
      const fieldType = schema.fields[fieldName].type;

      if (fieldType === 'Pointer' && object[fieldName]) {
        object[fieldName] = {
          objectId: object[fieldName],
          __type: 'Pointer',
          className: schema.fields[fieldName].targetClass,
        };
      }
      if (fieldType === 'Relation') {
        object[fieldName] = {
          __type: 'Relation',
          className: schema.fields[fieldName].targetClass,
        };
      }
      if (fieldType === 'Boolean' && object[fieldName] !== undefined) {
        object[fieldName] = fromOracleBoolean(object[fieldName]);
      }
      if (fieldType === 'GeoPoint' && object[fieldName]) {
        // Parse JSON stored GeoPoint
        const geoPoint = typeof object[fieldName] === 'string'
          ? JSON.parse(object[fieldName])
          : object[fieldName];
        object[fieldName] = {
          __type: 'GeoPoint',
          latitude: geoPoint.latitude,
          longitude: geoPoint.longitude,
        };
      }
      if (fieldType === 'Polygon' && object[fieldName]) {
        // Parse JSON stored Polygon
        const polygon = typeof object[fieldName] === 'string'
          ? JSON.parse(object[fieldName])
          : object[fieldName];
        object[fieldName] = {
          __type: 'Polygon',
          coordinates: polygon.coordinates,
        };
      }
      if (fieldType === 'File' && object[fieldName]) {
        object[fieldName] = {
          __type: 'File',
          name: object[fieldName],
        };
      }
      if (fieldType === 'Object' && object[fieldName]) {
        object[fieldName] = typeof object[fieldName] === 'string'
          ? JSON.parse(object[fieldName])
          : object[fieldName];
      }
      if (fieldType === 'Array' && object[fieldName]) {
        object[fieldName] = typeof object[fieldName] === 'string'
          ? JSON.parse(object[fieldName])
          : object[fieldName];
      }
    });

    // Handle dates
    if (object.createdAt && object.createdAt instanceof Date) {
      object.createdAt = object.createdAt.toISOString();
    }
    if (object.updatedAt && object.updatedAt instanceof Date) {
      object.updatedAt = object.updatedAt.toISOString();
    }
    if (object.expiresAt && object.expiresAt instanceof Date) {
      object.expiresAt = {
        __type: 'Date',
        iso: object.expiresAt.toISOString(),
      };
    }

    // Special date fields
    const dateFields = [
      '_email_verify_token_expires_at',
      '_account_lockout_expires_at',
      '_perishable_token_expires_at',
      '_password_changed_at',
    ];
    dateFields.forEach(field => {
      if (object[field] && object[field] instanceof Date) {
        object[field] = {
          __type: 'Date',
          iso: object[field].toISOString(),
        };
      }
    });

    // Remove null values and convert remaining dates
    for (const fieldName in object) {
      if (object[fieldName] === null) {
        delete object[fieldName];
      }
      if (object[fieldName] instanceof Date) {
        object[fieldName] = {
          __type: 'Date',
          iso: object[fieldName].toISOString(),
        };
      }
    }

    return object;
  }

  async ensureUniqueness(className: string, schema: SchemaType, fieldNames: string[]) {
    const conn = await this._getConnection();
    try {
      const constraintName = `${className}_unique_${fieldNames.sort().join('_')}`.substring(0, 128);
      const columns = fieldNames.map(f => quoteIdentifier(f)).join(', ');

      await conn.execute(
        `CREATE UNIQUE INDEX ${quoteIdentifier(constraintName)} ON ${quoteIdentifier(this._prefixTableName(className))} (${columns})`
      );
      await conn.commit();
    } catch (error) {
      if (error.errorNum === OracleDuplicateTableError) {
        // Index already exists
        return;
      }
      if (error.errorNum === OracleUniqueConstraintViolation) {
        throw new Parse.Error(
          Parse.Error.DUPLICATE_VALUE,
          'A duplicate value for a field with unique values was provided'
        );
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  async count(
    className: string,
    schema: SchemaType,
    query: QueryType,
    readPreference?: string,
    estimate?: boolean = true
  ) {
    debug('count');
    const conn = await this._getConnection();

    try {
      schema = toOracleSchema(schema);

      const where = buildWhereClause({
        schema,
        query,
        index: 1,
        caseInsensitive: false,
      });

      const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';

      // For estimate, Oracle doesn't have a direct equivalent to pg_class.reltuples
      // We could use NUM_ROWS from user_tables but it requires ANALYZE
      // For Milestone 1, always use exact count
      const prefixedClassName = this._prefixTableName(className);
      const sql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(prefixedClassName)} ${wherePattern}`;

      const result = await conn.execute(sql, where.values);
      return result.rows[0].CNT;
    } catch (error) {
      if (error.errorNum === OracleTableDoesNotExistError) {
        return 0;
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  async distinct(className: string, schema: SchemaType, query: QueryType, fieldName: string) {
    debug('distinct');
    const conn = await this._getConnection();

    try {
      schema = toOracleSchema(schema);

      const isPointerField =
        schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';

      const where = buildWhereClause({
        schema,
        query,
        index: 1,
        caseInsensitive: false,
      });

      const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';

      const prefixedClassName = this._prefixTableName(className);
      const sql = `SELECT DISTINCT ${quoteIdentifier(fieldName)} FROM ${quoteIdentifier(prefixedClassName)} ${wherePattern}`;

      const result = await conn.execute(sql, where.values);

      return result.rows
        .filter(row => row[fieldName.toUpperCase()] !== null)
        .map(row => {
          const value = row[fieldName.toUpperCase()];
          if (!isPointerField) {
            return value;
          }
          return {
            __type: 'Pointer',
            className: schema.fields[fieldName].targetClass,
            objectId: value,
          };
        });
    } catch (error) {
      if (error.errorNum === OracleMissingColumnError) {
        return [];
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  async aggregate(
    className: string,
    schema: any,
    pipeline: any,
    readPreference: ?string,
    hint: ?mixed,
    explain?: boolean
  ) {
    debug('aggregate');
    // Aggregate is complex and will be fully implemented in Milestone 2
    // For Milestone 1, implement basic aggregation
    const conn = await this._getConnection();

    try {
      schema = toOracleSchema(schema);

      let columns = ['*'];
      let wherePattern = '';
      let groupPattern = '';
      let sortPattern = '';
      let limitPattern = '';
      let skipPattern = '';
      const values = {};
      let paramIndex = 1;

      for (const stage of pipeline) {
        if (stage.$match) {
          const where = buildWhereClause({
            schema,
            query: stage.$match,
            index: paramIndex,
            caseInsensitive: false,
          });
          wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
          Object.assign(values, where.values);
          paramIndex += Object.keys(where.values).length;
        }

        if (stage.$limit) {
          limitPattern = `FETCH NEXT ${stage.$limit} ROWS ONLY`;
        }

        if (stage.$skip) {
          skipPattern = `OFFSET ${stage.$skip} ROWS`;
        }

        if (stage.$sort) {
          const sorting = Object.keys(stage.$sort)
            .map(key => {
              const direction = stage.$sort[key] === 1 ? 'ASC' : 'DESC';
              return `${quoteIdentifier(key)} ${direction}`;
            })
            .join(', ');
          sortPattern = `ORDER BY ${sorting}`;
        }

        if (stage.$group) {
          columns = [];
          const groupColumns = [];

          for (const field in stage.$group) {
            const value = stage.$group[field];

            if (field === '_id' && typeof value === 'string' && value !== '') {
              const sourceField = value.startsWith('$') ? value.substring(1) : value;
              columns.push(`${quoteIdentifier(sourceField)} AS "objectId"`);
              groupColumns.push(quoteIdentifier(sourceField));
            } else if (field === '_id' && typeof value === 'object' && Object.keys(value).length !== 0) {
              // Handle complex _id with multiple fields (potentially with date operations)
              for (const alias in value) {
                if (typeof value[alias] === 'string' && value[alias]) {
                  const source = value[alias].startsWith('$') ? value[alias].substring(1) : value[alias];
                  const quotedSource = quoteIdentifier(source);
                  if (!groupColumns.includes(quotedSource)) {
                    groupColumns.push(quotedSource);
                  }
                  columns.push(`${quotedSource} AS ${quoteIdentifier(alias)}`);
                } else if (typeof value[alias] === 'object') {
                  // Handle date extraction operations
                  const operation = Object.keys(value[alias])[0];
                  const source = value[alias][operation];
                  const sourceField = source.startsWith('$') ? source.substring(1) : source;
                  const quotedSource = quoteIdentifier(sourceField);

                  if (mongoAggregateToOracle[operation]) {
                    const dateOp = mongoAggregateToOracle[operation];
                    let extractExpr;

                    if (dateOp.type === 'EXTRACT') {
                      extractExpr = `EXTRACT(${dateOp.value} FROM ${quotedSource} AT TIME ZONE 'UTC')`;
                    } else {
                      // TO_CHAR for non-EXTRACT operations
                      extractExpr = `TO_NUMBER(TO_CHAR(${quotedSource} AT TIME ZONE 'UTC', '${dateOp.value}'))`;
                    }

                    if (!groupColumns.includes(quotedSource)) {
                      groupColumns.push(quotedSource);
                    }
                    columns.push(`${extractExpr} AS ${quoteIdentifier(alias)}`);
                  }
                }
              }
            } else if (typeof value === 'object') {
              if (value.$sum !== undefined) {
                if (typeof value.$sum === 'string') {
                  const sourceField = value.$sum.startsWith('$') ? value.$sum.substring(1) : value.$sum;
                  columns.push(`SUM(${quoteIdentifier(sourceField)}) AS ${quoteIdentifier(field)}`);
                } else {
                  columns.push(`COUNT(*) AS ${quoteIdentifier(field)}`);
                }
              }
              if (value.$avg) {
                const sourceField = value.$avg.startsWith('$') ? value.$avg.substring(1) : value.$avg;
                columns.push(`AVG(${quoteIdentifier(sourceField)}) AS ${quoteIdentifier(field)}`);
              }
              if (value.$max) {
                const sourceField = value.$max.startsWith('$') ? value.$max.substring(1) : value.$max;
                columns.push(`MAX(${quoteIdentifier(sourceField)}) AS ${quoteIdentifier(field)}`);
              }
              if (value.$min) {
                const sourceField = value.$min.startsWith('$') ? value.$min.substring(1) : value.$min;
                columns.push(`MIN(${quoteIdentifier(sourceField)}) AS ${quoteIdentifier(field)}`);
              }
            }
          }

          if (groupColumns.length > 0) {
            groupPattern = `GROUP BY ${groupColumns.join(', ')}`;
          }
        }

        if (stage.$project) {
          if (columns[0] === '*') {
            columns = [];
          }
          for (const field in stage.$project) {
            if (stage.$project[field] === 1 || stage.$project[field] === true) {
              columns.push(quoteIdentifier(field));
            }
          }
        }
      }

      const prefixedClassName = this._prefixTableName(className);
      const sql = `SELECT ${columns.join(', ')} FROM ${quoteIdentifier(prefixedClassName)} ${wherePattern} ${groupPattern} ${sortPattern} ${skipPattern} ${limitPattern}`;

      const result = await conn.execute(sql, values);

      return result.rows.map(row => {
        const obj = this.oracleObjectToParseObject(className, row, schema);
        if (!Object.prototype.hasOwnProperty.call(obj, 'objectId')) {
          obj.objectId = null;
        }
        return obj;
      });
    } catch (error) {
      if (error.errorNum === OracleTableDoesNotExistError) {
        return [];
      }
      throw error;
    } finally {
      await conn.close();
    }
  }

  async performInitialization({ VolatileClassesSchemas }: any) {
    debug('performInitialization');
    await this._ensureConnection();
    await this._ensureSchemaCollectionExists();
    await this._ensureStoredFunctionsExist();

    const promises = VolatileClassesSchemas.map(schema => {
      return this.createTable(schema.className, schema)
        .catch(err => {
          if (
            err.errorNum === OracleDuplicateTableError ||
            err.code === Parse.Error.INVALID_CLASS_NAME
          ) {
            return Promise.resolve();
          }
          throw err;
        })
        .then(() => this.schemaUpgrade(schema.className, schema));
    });

    return Promise.all(promises)
      .then(() => {
        debug('initializationDone');
      })
      .catch(error => {
        console.error(error);
      });
  }

  async _ensureStoredFunctionsExist() {
    debug('_ensureStoredFunctionsExist');
    const conn = await this._getConnection();
    try {
      const functionDefinitions = oracleSql.getAllFunctionDefinitions();
      for (const sql of functionDefinitions) {
        try {
          // Execute each function definition
          // Oracle requires executing PL/SQL blocks with execute
          await conn.execute(sql);
        } catch (error) {
          // Ignore errors for functions that already exist or have minor issues
          // The functions use CREATE OR REPLACE so they should update if changed
          debug('Function creation warning:', error.message);
        }
      }
      await conn.commit();
    } finally {
      await conn.close();
    }
  }

  async createIndexes(className: string, indexes: any, conn: ?any): Promise<void> {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      for (const index of indexes) {
        const columns = Object.keys(index.key).map(k => quoteIdentifier(k)).join(', ');
        const indexName = index.name.substring(0, 128);

        try {
          await conn.execute(
            `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(this._prefixTableName(className))} (${columns})`
          );
        } catch (error) {
          if (error.errorNum !== OracleDuplicateTableError) {
            throw error;
          }
        }
      }
      await conn.commit();
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async getIndexes(className: string) {
    const conn = await this._getConnection();
    try {
      const prefixedClassName = this._prefixTableName(className);
      const result = await conn.execute(
        `SELECT index_name, column_name FROM user_ind_columns WHERE table_name = :prefixedClassName`,
        { prefixedClassName }
      );
      return result.rows;
    } finally {
      await conn.close();
    }
  }

  async updateSchemaWithIndexes(): Promise<void> {
    return Promise.resolve();
  }

  // Used for testing purposes
  async updateEstimatedCount(className: string) {
    // Oracle uses DBMS_STATS.GATHER_TABLE_STATS for this purpose
    // For now, we execute ANALYZE equivalent
    const conn = await this._getConnection();
    try {
      const prefixedClassName = this._prefixTableName(className);
      await conn.execute(
        `BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, :prefixedClassName); END;`,
        { prefixedClassName }
      );
      await conn.commit();
    } catch (error) {
      // Ignore errors - stats gathering may not be available in all environments
      debug('updateEstimatedCount warning:', error.message);
    } finally {
      await conn.close();
    }
  }

  async createIndexesIfNeeded(
    className: string,
    fieldName: string,
    type: any,
    conn: ?any
  ): Promise<void> {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      const indexName = `${fieldName}`.substring(0, 128);
      await conn.execute(
        `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(this._prefixTableName(className))} (${quoteIdentifier(type)})`
      );
      await conn.commit();
    } catch (error) {
      if (error.errorNum !== OracleDuplicateTableError) {
        throw error;
      }
      // Index already exists, ignore
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async dropIndexes(className: string, indexes: any, conn: ?any): Promise<void> {
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      for (const indexName of indexes) {
        try {
          await conn.execute(`DROP INDEX ${quoteIdentifier(indexName)}`);
        } catch (error) {
          // Ignore errors if index doesn't exist
          if (error.errorNum !== OracleTableDoesNotExistError) {
            debug('dropIndexes warning:', error.message);
          }
        }
      }
      await conn.commit();
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async deleteIdempotencyFunction(options?: Object = {}): Promise<any> {
    const conn = options.conn || (await this._getConnection());
    const shouldRelease = !options.conn;

    try {
      await conn.execute('DROP FUNCTION IF EXISTS parse_idempotency_delete_expired');
      await conn.commit();
    } catch (error) {
      // Ignore errors - function may not exist
      debug('deleteIdempotencyFunction warning:', error.message);
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async ensureIdempotencyFunctionExists(options?: Object = {}): Promise<any> {
    const conn = options.conn || (await this._getConnection());
    const shouldRelease = !options.conn;
    const ttlSeconds = options.ttl !== undefined ? options.ttl : 60;

    try {
      // Create a stored procedure for deleting expired idempotency records
      // Oracle doesn't support dynamic interval in the same way as PostgreSQL
      await conn.execute(`
        CREATE OR REPLACE PROCEDURE parse_idempotency_delete_expired AS
        BEGIN
          DELETE FROM "_Idempotency" WHERE "expire" < (SYSTIMESTAMP - INTERVAL '${ttlSeconds}' SECOND);
          COMMIT;
        END;
      `);
      await conn.commit();
    } catch (error) {
      debug('ensureIdempotencyFunctionExists warning:', error.message);
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async createTransactionalSession(): Promise<any> {
    return new Promise(async (resolve) => {
      const conn = await this._getConnection();
      const transactionalSession = {};
      transactionalSession.conn = conn;
      transactionalSession.t = conn; // Alias for compatibility with PostgreSQL pattern
      transactionalSession.batch = [];
      transactionalSession.promise = new Promise((resolveInner) => {
        transactionalSession.resolve = resolveInner;
      });
      transactionalSession.result = transactionalSession.promise.then(async () => {
        // Wait for all batch operations to complete
        await Promise.all(transactionalSession.batch);
        await conn.commit();
        await conn.close();
      }).catch(async (error) => {
        await conn.rollback();
        await conn.close();
        throw error;
      });
      resolve(transactionalSession);
    });
  }

  async commitTransactionalSession(transactionalSession: any): Promise<void> {
    // Resolve the inner promise to trigger commit
    transactionalSession.resolve();
    return transactionalSession.result;
  }

  async abortTransactionalSession(transactionalSession: any): Promise<void> {
    // Add a rejection to trigger rollback
    transactionalSession.batch.push(Promise.reject(new Error('Transaction aborted')));
    transactionalSession.resolve();
    try {
      await transactionalSession.result;
    } catch (error) {
      // Expected - transaction was aborted
    }
  }

  async ensureIndex(
    className: string,
    schema: SchemaType,
    fieldNames: string[],
    indexName: ?string,
    caseInsensitive: boolean = false,
    options?: Object = {}
  ): Promise<any> {
    const conn = options.conn || (await this._getConnection());
    const shouldRelease = !options.conn;

    try {
      const defaultIndexName = `parse_default_${fieldNames.sort().join('_')}`.substring(0, 128);
      const finalIndexName = indexName || defaultIndexName;

      const columns = caseInsensitive
        ? fieldNames.map(f => `LOWER(${quoteIdentifier(f)})`).join(', ')
        : fieldNames.map(f => quoteIdentifier(f)).join(', ');

      await conn.execute(
        `CREATE INDEX ${quoteIdentifier(finalIndexName)} ON ${quoteIdentifier(this._prefixTableName(className))} (${columns})`
      );
      await conn.commit();
    } catch (error) {
      if (error.errorNum === OracleDuplicateTableError) {
        // Index already exists
        return;
      }
      if (error.errorNum === OracleUniqueConstraintViolation) {
        throw new Parse.Error(
          Parse.Error.DUPLICATE_VALUE,
          'A duplicate value for a field with unique values was provided'
        );
      }
      throw error;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }
}

export default OracleStorageAdapter;
