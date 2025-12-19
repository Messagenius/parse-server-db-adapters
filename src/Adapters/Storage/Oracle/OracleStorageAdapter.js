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

const logger = require('../../../logger');

const debug = function (...args: any) {
  args = ['ORACLE: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
};

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
      return 'VARCHAR2(4000)';
    case 'Boolean':
      return 'NUMBER(1)'; // Oracle has no boolean type for tables
    case 'Pointer':
      return 'VARCHAR2(4000)';
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

// Mongo aggregate date parts to Oracle EXTRACT
const mongoAggregateToOracle = {
  $dayOfMonth: 'DAY',
  $dayOfWeek: 'D', // Oracle uses D for day of week (1-7)
  $dayOfYear: 'DDD',
  $hour: 'HOUR',
  $minute: 'MINUTE',
  $second: 'SECOND',
  $month: 'MONTH',
  $week: 'WW',
  $year: 'YEAR',
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

const transformValue = value => {
  if (typeof value === 'object' && value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
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
        patterns.push(`REGEXP_LIKE(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}'), :v${index})`);
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
            patterns.push(`CAST(JSON_VALUE(${dotInfo.column}, '${dotInfo.path}') AS NUMBER) ${ParseToOracleComparator[cmp]} :v${index}`);
            values[`v${index}`] = cmpValue;
            index += 1;
          }
        });
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

    if (fieldValue.$ne !== undefined) {
      if (fieldValue.$ne === null) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NOT NULL`);
      } else {
        patterns.push(`(${quoteIdentifier(fieldName)} <> :v${index} OR ${quoteIdentifier(fieldName)} IS NULL)`);
        values[`v${index}`] = fieldValue.$ne;
        index += 1;
      }
    }

    if (fieldValue.$eq !== undefined) {
      if (fieldValue.$eq === null) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NULL`);
      } else {
        patterns.push(`${quoteIdentifier(fieldName)} = :v${index}`);
        values[`v${index}`] = fieldValue.$eq;
        index += 1;
      }
    }

    // Handle $in and $nin
    if (Array.isArray(fieldValue.$in)) {
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
          values[paramName] = val;
          return `:${paramName}`;
        });
        patterns.push(`${quoteIdentifier(fieldName)} IN (${inParams.join(', ')})`);
        index += fieldValue.$in.length;
      }
    }

    if (Array.isArray(fieldValue.$nin)) {
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
          values[paramName] = val;
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
      } else {
        // Use stored function to check that all values exist in the array
        const allValues = JSON.stringify(fieldValue.$all);
        patterns.push(`parse_array_contains_all(${quoteIdentifier(fieldName)}, :v${index}) = 1`);
        values[`v${index}`] = allValues;
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

    if (typeof fieldValue.$exists !== 'undefined') {
      if (fieldValue.$exists) {
        patterns.push(`${quoteIdentifier(fieldName)} IS NOT NULL`);
      } else {
        patterns.push(`${quoteIdentifier(fieldName)} IS NULL`);
      }
    }

    if (fieldValue.$regex) {
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

  async handleShutdown() {
    if (this._pool) {
      try {
        await this._pool.close(0); // Force close with 0 drain time
      } catch (error) {
        console.error('Error closing Oracle pool:', error);
      }
      this._pool = null;
      this._initialized = false;
    }
  }

  _notifySchemaChange() {
    // Schema change notification - simplified for now
    // Oracle doesn't have LISTEN/NOTIFY like PostgreSQL
    // Could implement using AQ (Advanced Queuing) in the future
    this._onchange();
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
      const result = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM user_tables WHERE table_name = :name`,
        { name }
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
        let schema = JSON.parse(result.rows[0].schema);
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
            `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(className)} (${columns})`
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
      await this.createTable(className, schema, conn);

      // Insert into _SCHEMA
      await conn.execute(
        `INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES (:className, :schema, 1)`,
        { className, schema: JSON.stringify(schema) }
      );

      await this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields, conn);
      await conn.commit();

      this._notifySchemaChange();
      return toParseSchema(schema);
    } catch (err) {
      await conn.rollback();
      if (err.errorNum === OracleUniqueConstraintViolation) {
        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }
      throw err;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
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
        const oracleType = parseTypeToOracleType(parseType);
        columns.push(`${quoteIdentifier(fieldName)} ${oracleType}`);

        if (fieldName === 'objectId') {
          columns.push(`PRIMARY KEY (${quoteIdentifier(fieldName)})`);
        }
      });

      const createTableSQL = `CREATE TABLE ${quoteIdentifier(className)} (${columns.join(', ')})`;

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
      // Get existing columns
      const result = await conn.execute(
        `SELECT column_name FROM user_tab_columns WHERE table_name = :className`,
        { className }
      );
      const existingColumns = result.rows.map(row => row.COLUMN_NAME);

      // Add missing columns
      for (const fieldName of Object.keys(schema.fields)) {
        if (!existingColumns.includes(fieldName)) {
          await this.addFieldIfNotExists(className, fieldName, schema.fields[fieldName], conn);
        }
      }
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
  }

  async addFieldIfNotExists(className: string, fieldName: string, type: any, conn: ?any) {
    debug('addFieldIfNotExists');
    const shouldRelease = !conn;
    conn = conn || (await this._getConnection());

    try {
      if (type.type !== 'Relation') {
        const oracleType = parseTypeToOracleType(type);
        try {
          await conn.execute(
            `ALTER TABLE ${quoteIdentifier(className)} ADD ${quoteIdentifier(fieldName)} ${oracleType}`
          );
        } catch (error) {
          if (error.errorNum === OracleTableDoesNotExistError) {
            return this.createClass(className, { fields: { [fieldName]: type } }, conn);
          }
          if (error.errorNum !== OracleDuplicateColumnError) {
            throw error;
          }
          // Column already exists, created by other request
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

      // Update schema in _SCHEMA table
      const schemaResult = await conn.execute(
        `SELECT "schema" FROM "_SCHEMA" WHERE "className" = :className`,
        { className }
      );

      if (schemaResult.rows.length > 0) {
        const existingSchema = JSON.parse(schemaResult.rows[0].schema);
        if (existingSchema.fields[fieldName]) {
          throw 'Attempted to add a field that already exists';
        }
        existingSchema.fields[fieldName] = type;

        await conn.execute(
          `UPDATE "_SCHEMA" SET "schema" = :schema WHERE "className" = :className`,
          { schema: JSON.stringify(existingSchema), className }
        );
      }

      await conn.commit();
      this._notifySchemaChange();
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
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
        const schema = JSON.parse(result.rows[0].schema);
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
      await conn.execute(`DROP TABLE ${quoteIdentifier(className)}`);
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
      const joins = results.reduce((list, schema) => {
        const schemaObj = typeof schema.schema === 'string'
          ? JSON.parse(schema.schema)
          : schema.schema;
        return list.concat(joinTablesForSchema(schemaObj));
      }, []);

      const classes = [
        '_SCHEMA',
        '_PushStatus',
        '_JobStatus',
        '_JobSchedule',
        '_Hooks',
        '_GlobalConfig',
        '_GraphQLConfig',
        '_Audience',
        '_Idempotency',
        ...results.map(result => result.className),
        ...joins,
      ];

      // Drop all tables
      for (const tableName of classes) {
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
      for (const columnName of columnsToDelete) {
        try {
          await conn.execute(
            `ALTER TABLE ${quoteIdentifier(className)} DROP COLUMN ${quoteIdentifier(columnName)}`
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
      return result.rows.map(row => {
        const schema = typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema;
        return toParseSchema({ className: row.className, ...schema });
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

      const schema = typeof result.rows[0].schema === 'string'
        ? JSON.parse(result.rows[0].schema)
        : result.rows[0].schema;
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
      placeholders.push(`:${paramName}`);

      if (!schema.fields[fieldName] && className === '_User') {
        // Handle special _User fields
        if (
          fieldName === '_email_verify_token' ||
          fieldName === '_failed_login_count' ||
          fieldName === '_perishable_token' ||
          fieldName === '_password_history'
        ) {
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

      const fieldType = schema.fields[fieldName]?.type;
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
        case 'Number':
          values[paramName] = object[fieldName];
          break;
        case 'Boolean':
          values[paramName] = toOracleBoolean(object[fieldName]);
          break;
        case 'File':
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

    const sql = `INSERT INTO ${quoteIdentifier(className)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;

    try {
      await conn.execute(sql, values);
      if (!transactionalSession) {
        await conn.commit();
      }
      return { ops: [object] };
    } catch (error) {
      if (!transactionalSession) {
        await conn.rollback();
      }
      if (error.errorNum === OracleUniqueConstraintViolation) {
        const err = new Parse.Error(
          Parse.Error.DUPLICATE_VALUE,
          'A duplicate value for a field with unique values was provided'
        );
        err.underlyingError = error;
        throw err;
      }
      throw error;
    } finally {
      if (shouldRelease) {
        await conn.close();
      }
    }
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

    try {
      const where = buildWhereClause({
        schema,
        query,
        index: 1,
        caseInsensitive: false,
      });

      const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : 'WHERE 1=1';

      // Oracle doesn't have DELETE ... RETURNING count directly, use a workaround
      const sql = `DELETE FROM ${quoteIdentifier(className)} ${wherePattern}`;
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
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
          values[paramName] = toOracleValue(fieldValue);
        } else if (fieldValue.__type === 'File') {
          const paramName = `u${paramIndex++}`;
          updateClauses.push(`${quoteIdentifier(fieldName)} = :${paramName}`);
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

      // Update and then select the updated rows
      const updateSql = `UPDATE ${quoteIdentifier(className)} SET ${updateClauses.join(', ')} ${whereClause}`;
      await conn.execute(updateSql, values);

      // Fetch the updated rows
      const selectSql = `SELECT * FROM ${quoteIdentifier(className)} ${whereClause}`;
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
          .map(key => {
            const direction = sort[key] === 1 ? 'ASC' : 'DESC';
            return `${quoteIdentifier(key)} ${direction}`;
          })
          .join(', ');
        sortPattern = sorting.length > 0 ? `ORDER BY ${sorting}` : '';
      }

      // Build column selection
      let columns = '*';
      if (keys) {
        keys = keys.reduce((memo, key) => {
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

      const sql = `SELECT ${columns} FROM ${quoteIdentifier(className)} ${wherePattern} ${sortPattern} ${paginationPattern}`;

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
      const fieldName = Object.keys(schema.fields).find(
        f => f.toUpperCase() === key.toUpperCase()
      ) || key;
      result[fieldName] = object[key];
    }
    object = result;

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
        `CREATE UNIQUE INDEX ${quoteIdentifier(constraintName)} ON ${quoteIdentifier(className)} (${columns})`
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
      const sql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(className)} ${wherePattern}`;

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

      const sql = `SELECT DISTINCT ${quoteIdentifier(fieldName)} FROM ${quoteIdentifier(className)} ${wherePattern}`;

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

      const sql = `SELECT ${columns.join(', ')} FROM ${quoteIdentifier(className)} ${wherePattern} ${groupPattern} ${sortPattern} ${skipPattern} ${limitPattern}`;

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
            `CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(className)} (${columns})`
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
      const result = await conn.execute(
        `SELECT index_name, column_name FROM user_ind_columns WHERE table_name = :className`,
        { className }
      );
      return result.rows;
    } finally {
      await conn.close();
    }
  }

  async updateSchemaWithIndexes(): Promise<void> {
    return Promise.resolve();
  }

  async createTransactionalSession(): Promise<any> {
    const conn = await this._getConnection();
    return {
      conn,
      batch: [],
    };
  }

  async commitTransactionalSession(transactionalSession: any): Promise<void> {
    await transactionalSession.conn.commit();
    await transactionalSession.conn.close();
  }

  async abortTransactionalSession(transactionalSession: any): Promise<void> {
    await transactionalSession.conn.rollback();
    await transactionalSession.conn.close();
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
        `CREATE INDEX ${quoteIdentifier(finalIndexName)} ON ${quoteIdentifier(className)} (${columns})`
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
