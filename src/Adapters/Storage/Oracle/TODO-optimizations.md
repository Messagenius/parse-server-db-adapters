# Oracle Storage Adapter - Limitations and Future Optimizations

This document tracks known limitations, unsupported features, and planned optimizations for the Oracle Storage Adapter.

## Milestone 1 - Baseline SQL Compatibility

### Current Status
- **Target Database**: Oracle 19c
- **Connection Types**: Standard and Wallet-based (TNS)
- **Basic Operations**: Schema management, CRUD, simple queries

---

## Known Limitations (Milestone 1)

### Unsupported Parse Features

#### GeoPoint and Spatial Queries
- **Status**: Not supported in Milestone 1
- **Current Behavior**: GeoPoint and Polygon data stored as JSON in CLOB columns
- **Affected Operators**:
  - `$nearSphere` - Not supported
  - `$geoWithin` - Not supported
  - `$geoIntersects` - Not supported
  - `$within.$box` - Not supported
  - `$within.$polygon` - Not supported
  - `$centerSphere` - Not supported
- **Future**: Implement using Oracle Spatial (SDO_GEOMETRY) in Milestone 2/3

#### Full-Text Search
- **Status**: Not supported
- **Affected Operators**:
  - `$text.$search` - Not supported
- **Future**: Implement using Oracle Text in Milestone 2/3

#### Complex Array Operators
- **Status**: Limited support
- **Affected Operators**:
  - `$all` - Not supported (arrays stored as JSON)
  - `$containedBy` - Not supported
  - `$elemMatch` - Not supported
  - Array `$in` with nested arrays - Limited
- **Current Behavior**: Arrays stored as JSON in CLOB columns
- **Array Operations** (Add, Remove, AddUnique):
  - `Add` - Replaces entire array (does not append)
  - `Remove` - Clears array (does not selectively remove)
  - `AddUnique` - Replaces entire array (does not enforce uniqueness)
- **Future**: Consider Oracle nested tables or JSON_TABLE for advanced array operations

#### Dot Notation in Queries
- **Status**: Limited support
- **Current Behavior**: Basic dot notation in WHERE works, complex nested queries may fail
- **Future**: Full JSON path query support using JSON_VALUE/JSON_QUERY

---

### SQL/Oracle-Specific Limitations

#### Empty String Handling
- **Issue**: Oracle treats empty strings (`''`) as NULL
- **Impact**: String comparisons involving empty strings may behave differently than PostgreSQL/MongoDB
- **Workaround**: None for Milestone 1 - documented as known limitation
- **Future**: Consider storing empty strings as special marker or using additional column

#### Identifier Length
- **Limit**: Oracle 19c supports up to 128 characters for identifiers (30 in older versions)
- **Impact**: Long class names or field names may be truncated
- **Current Handling**: Names truncated to 128 characters

#### Boolean Type
- **Issue**: Oracle does not have a native BOOLEAN type for table columns
- **Current Implementation**: Using NUMBER(1) with 0/1 values
- **Impact**: Direct boolean comparisons converted to numeric

#### CLOB Comparison
- **Issue**: CLOBs cannot be directly compared using `=` in Oracle
- **Impact**: String comparisons on Object/Array type fields may require special handling
- **Current Handling**: JSON stored in CLOB, queries use JSON functions

---

### Query Limitations

#### Pagination
- **Implementation**: Using Oracle 12c+ syntax (`OFFSET ... ROWS FETCH NEXT ... ROWS ONLY`)
- **Status**: Working

#### Regex
- **Implementation**: Using `REGEXP_LIKE` function
- **Limitations**:
  - Regex syntax differs from PCRE/JavaScript regex
  - Some regex features may not work identically
  - `$options: 'x'` (extended) not supported

#### Case-Insensitive Queries
- **Implementation**: Using `LOWER()` function
- **Status**: Working for username/email fields

#### Estimated Count
- **Status**: Not supported
- **Current Behavior**: Always uses exact `COUNT(*)`
- **Future**: Could use `user_tables.num_rows` after ANALYZE

---

## Non-Goals (Milestone 1)

The following are explicitly NOT goals for Milestone 1:

1. **Full operator parity with PostgreSQL** - Complex operators deferred to Milestone 2
2. **Query optimization** - Deferred to Milestone 3
3. **Architecture refactoring** - Keep structure similar to PostgreSQL adapter
4. **Document-store (SODA) approach** - Using relational SQL approach only
5. **Oracle-specific advanced features** - Only basic SQL features used
6. **Schema change notifications** - PostgreSQL uses LISTEN/NOTIFY; Oracle would need AQ

---

## Milestone 2 - Query Feature Coverage (Planned)

### Planned Improvements

1. **GeoPoint Support**
   - Implement using Oracle Spatial SDO_GEOMETRY
   - Support `$nearSphere` with SDO_NN
   - Support `$geoWithin` with SDO_RELATE

2. **Full-Text Search**
   - Implement using Oracle Text
   - Support `$text.$search` with CONTAINS

3. **Array Operations**
   - Full JSON array manipulation using JSON_MERGEPATCH
   - `$all` using JSON_TABLE
   - `$containedBy` using JSON_QUERY

4. **Aggregation Pipeline**
   - Full support for `$group` with complex expressions
   - Date extraction functions
   - `$project` with computed fields

---

## Milestone 3 - Optimizations (Planned)

### Performance Optimizations

1. **Batch Operations**
   - Bulk INSERT using FORALL
   - Batch UPDATE optimization

2. **Query Optimization**
   - Query plan caching
   - Bind variable optimization
   - Index recommendations

3. **Connection Pooling**
   - Pool size tuning
   - Connection health checks
   - Session management

4. **Indexing Strategy**
   - JSON indexes for CLOB columns
   - Function-based indexes for case-insensitive search
   - Spatial indexes for GeoPoint

---

## Configuration Notes

### Environment Variables

For wallet-based connections:
- `TNS_ADMIN` - Directory containing tnsnames.ora and sqlnet.ora
- `ORACLE_CLIENT_LOCATION` - Oracle Instant Client location
- `ORACLE_WALLET_LOCATION` - Wallet location (if different from TNS_ADMIN)
- `LD_LIBRARY_PATH` - Include Oracle client libraries (Linux)

### Connection String Formats

```
# Standard connection
oracle://user:password@host:port/service_name

# Wallet-based (TNS alias)
oracle://user:password@TNS_ALIAS

# With pool options
oracle://user:password@host:port/service_name?poolMin=2&poolMax=10
```

---

## Version History

- **Milestone 1** (Current): Baseline Oracle SQL compatibility
  - Schema operations
  - Basic CRUD
  - Simple queries (WHERE, ORDER BY, pagination)
  - Standard and wallet-based connections
