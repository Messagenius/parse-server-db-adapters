# Oracle Storage Adapter - Limitations and Future Optimizations

This document tracks known limitations, unsupported features, and planned optimizations for the Oracle Storage Adapter.

## Milestone 1 - Baseline SQL Compatibility

### Current Status
- **Target Database**: Oracle 19c
- **Connection Types**: Standard and Wallet-based (TNS)
- **Basic Operations**: Schema management, CRUD, simple queries

---

## Milestone 2 - Query Feature Coverage (Completed)

### Implemented Features

#### GeoPoint Queries
- **Status**: Implemented using Haversine formula
- **Supported Operators**:
  - `$nearSphere` - Finds points near a location, sorted by distance
  - `$nearSphere` with `$maxDistance` - Limits results by distance (radians)
  - `$geoWithin.$box` - Finds points within a rectangular bounding box
  - `$geoWithin.$centerSphere` - Finds points within a circle (radius in radians)
  - `$geoWithin.$polygon` - Finds points within polygon bounding box (approximation)
- **Storage**: GeoPoint stored as JSON in CLOB: `{"latitude": x, "longitude": y}`
- **Distance Calculation**: Great-circle distance using Haversine formula

#### Dot Notation Queries
- **Status**: Fully implemented
- **Implementation**: Uses JSON_VALUE/JSON_QUERY for nested field access
- **Supported Operations**:
  - Equality: `{"data.nested.field": "value"}`
  - Comparison operators: `$gt`, `$lt`, `$gte`, `$lte`
  - `$in` / `$nin` on nested fields
  - `$exists` for nested field existence
  - `$ne` for nested field inequality
  - `$regex` on nested string fields

#### Array Operators
- **Status**: Implemented using JSON_TABLE and JSON_EXISTS
- **Supported Operators**:
  - `$in` - Check if field value is in array, or if array contains any of values
  - `$nin` - Negation of $in
  - `$all` - Check if array contains all specified values
  - `$containedBy` - Check if array is subset of specified values
- **Implementation Notes**:
  - Uses JSON_TABLE to unnest JSON arrays for comparison
  - Uses JSON_EXISTS with filter expressions for $all

#### Array Update Operations
- **Status**: Properly implemented with JSON_ARRAYAGG
- **Supported Operations**:
  - `Add` - Appends objects to existing array
  - `AddUnique` - Adds only unique objects (uses SQL UNION)
  - `Remove` - Removes specified objects from array
- **Implementation Notes**:
  - Uses JSON_ARRAYAGG with subqueries for atomic updates
  - Handles null/empty arrays gracefully

#### Polygon Support
- **Status**: Basic support implemented
- **Storage**: Polygon stored as JSON in CLOB with coordinates array
- **Queries**: Bounding box approximation for $geoIntersects
- **Note**: True polygon intersection queries require Oracle Spatial (future enhancement)

---

## Known Limitations

### Unsupported Parse Features

#### Full-Text Search
- **Status**: Not supported
- **Affected Operators**:
  - `$text.$search` - Not supported
- **Future**: Implement using Oracle Text in Milestone 3

#### Advanced Polygon Queries
- **Status**: Limited support
- **Affected Operators**:
  - `$geoIntersects` - Uses bounding box approximation
  - Point-in-polygon - Requires Oracle Spatial for accurate results
- **Future**: Consider Oracle Spatial (SDO_GEOMETRY) integration

#### $elemMatch
- **Status**: Not supported
- **Workaround**: Use application-level filtering
- **Future**: Could implement using JSON_TABLE with complex conditions

---

### SQL/Oracle-Specific Limitations

#### Empty String Handling
- **Issue**: Oracle treats empty strings (`''`) as NULL
- **Impact**: String comparisons involving empty strings may behave differently than PostgreSQL/MongoDB
- **Workaround**: None - documented as known limitation
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

## Non-Goals (Current Phase)

The following are explicitly NOT goals for current implementation:

1. **Oracle Spatial integration** - Using JSON-based approach for GeoPoint
2. **Oracle Text integration** - Full-text search deferred
3. **Document-store (SODA) approach** - Using relational SQL approach only
4. **Schema change notifications** - PostgreSQL uses LISTEN/NOTIFY; Oracle would need AQ

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
   - Potential spatial indexes if Oracle Spatial is adopted

5. **Full-Text Search**
   - Implement using Oracle Text
   - Support `$text.$search` with CONTAINS

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

- **Milestone 1**: Baseline Oracle SQL compatibility
  - Schema operations
  - Basic CRUD
  - Simple queries (WHERE, ORDER BY, pagination)
  - Standard and wallet-based connections

- **Milestone 2** (Current): Query Feature Coverage
  - GeoPoint queries ($nearSphere, $geoWithin.$box, $geoWithin.$centerSphere)
  - Dot notation queries with JSON_VALUE/JSON_QUERY
  - Array operators ($all, $containedBy, $in, $nin on arrays)
  - Proper array update operations (Add, AddUnique, Remove)
  - Polygon basic storage/retrieval
