# Oracle Adapter Test Coverage Analysis

## Executive Summary

The Oracle adapter has **basic test coverage** but is **missing many comprehensive tests** compared to MongoDB and PostgreSQL adapters. This document outlines what exists and what's missing.

---

## Current Test Files (3 files)

### ✅ 1. `OracleConfigParser.spec.js` (135 lines)
**Status:** ✅ **COMPLETE** - Well-tested

**Coverage:**
- Query parameter parsing
- Standard connection strings
- TNS alias connections
- URL encoding of credentials
- External authentication
- Pool configuration options
- Default values and validation

**Verdict:** This is comprehensive and matches PostgreSQL's config parser tests.

---

### ✅ 2. `OracleInitOptions.spec.js` (91 lines)
**Status:** ✅ **GOOD** - Basic coverage

**Coverage:**
- Default database options
- `oracledb://` protocol support
- Custom pool options (poolMin, poolMax, poolIncrement)
- Schema cache TTL option
- enableSchemaHooks option

**Verdict:** Good basic initialization tests. Could add more edge cases.

---

### ⚠️ 3. `OracleStorageAdapter.spec.js` (715 lines)
**Status:** ⚠️ **EXTENSIVE BUT INCOMPLETE**

**What's Covered (Good!):**
- ✅ Schema operations (createTable, schemaUpgrade, getClass)
- ✅ Basic CRUD (create, read, update, delete)
- ✅ Query operators ($gt, $lt, $gte, $lte, $in, $nin)
- ✅ Pagination (skip, limit)
- ✅ Sorting (ascending, descending)
- ✅ Count queries
- ✅ Boolean fields
- ✅ Date fields
- ✅ Object and Array fields
- ✅ Dot notation queries (nested objects)
- ✅ Array operations ($all, Add, AddUnique, Remove)
- ✅ GeoPoint storage and retrieval
- ✅ GeoPoint queries ($nearSphere, $geoWithin.$box)
- ✅ Connection pool shutdown

**What's Missing (See below):**

---

## Missing Tests - Critical Gaps

### 🔴 **1. Generic Tests with Oracle Exclusions**

Currently, **11 tests exclude PostgreSQL** but **DO NOT exclude Oracle**. These may fail or behave unexpectedly on Oracle:

#### Tests that exclude `['postgres']`:
```javascript
// spec/schemas.spec.js
- 'get indexes on startup' (line 3653)
- 'get compound indexes on startup' (line 3676)  
- 'cannot update to duplicate value on unique index' (line 3711)

// spec/RestQuery.spec.js
- 'query for user w/ legacy credentials without masterKey' (line 55)
- 'query for user w/ legacy credentials with masterKey' (line 73)
- 'query with include' (line 92)

// spec/ParseUser.spec.js
- 'should cleanup null authData keys' (line 2817)
- 'should not serve null authData keys' (line 2853)

// spec/ParseQuery.spec.js
- 'querying for null value' (line 3827)

// spec/ParseQuery.Aggregate.spec.js
- 'group and multiply transform' (line 299)
- 'project and multiply transform' (line 322)
```

**ACTION REQUIRED:** Test each of these with Oracle and either:
1. Fix Oracle adapter to support them, OR
2. Add `'oracle'` to the exclusion list: `it_exclude_dbs(['postgres', 'oracle'])`

---

### 🔴 **2. Missing Advanced Query Tests**

Compared to MongoDB (686 lines) and PostgreSQL (591 lines), Oracle tests (715 lines) are missing:

#### A. **Regex Queries**
```javascript
// Missing tests for:
- $regex operator
- Case-insensitive regex
- Regex with special characters
- containsAll with regex
```

#### B. **$exists Operator**
```javascript
// Missing tests for:
- Query for fields that exist
- Query for fields that don't exist
- $exists: true
- $exists: false
```

#### C. **$select and $dontSelect**
```javascript
// Missing tests for:
- Selecting specific fields
- Excluding specific fields
- Nested field selection
```

#### D. **Relation Queries**
```javascript
// Missing tests for:
- Pointer queries
- Relation queries
- $relatedTo operator
- $inQuery operator
- $notInQuery operator
```

#### E. **Advanced Array Queries**
```javascript
// Missing tests for:
- $size operator (array length)
- $elemMatch operator
- Array of pointers
```

#### F. **Aggregate Queries**
```javascript
// Missing tests for:
- $group operations
- $match operations
- $project operations
- $sort in aggregation
- $limit in aggregation
- Pipeline stages
```

#### G. **Full-Text Search**
```javascript
// Missing tests for:
- $text operator
- Text search queries
- Language-specific search
```

#### H. **Polygon Queries**
```javascript
// Missing tests for:
- Parse.Polygon storage
- $geoIntersects
- Polygon queries
```

---

### 🔴 **3. Missing Edge Cases & Error Handling**

#### A. **Connection & Pool Management**
```javascript
// Missing tests for:
- Connection timeout handling
- Pool exhaustion scenarios
- Connection retry logic
- Graceful degradation
- Multiple concurrent connections
```

#### B. **Transaction Tests**
```javascript
// Missing tests for:
- Transaction support (if implemented)
- Rollback scenarios
- Concurrent writes
- Optimistic locking
```

#### C. **Schema Validation**
```javascript
// Missing tests for:
- Invalid schema operations
- Schema migration edge cases
- Column type changes
- Constraint violations
```

#### D. **Data Type Edge Cases**
```javascript
// Missing tests for:
- Very large numbers
- Unicode strings
- Binary data (Bytes type)
- File pointers
- Large arrays/objects (JSON size limits)
- Null vs undefined handling
- Empty strings vs null
```

#### E. **Performance & Limits**
```javascript
// Missing tests for:
- Large result sets
- Query timeout handling
- Memory limits
- Maximum query complexity
```

---

### 🔴 **4. Missing Integration Tests**

#### A. **Parse SDK Features**
```javascript
// Missing tests for:
- Parse.User specific operations
- Parse.Session operations
- Parse.Role and ACL with Oracle
- Parse.Installation
- Parse.Config
- Cloud Code integration
- Hooks (beforeSave, afterSave, etc.)
```

#### B. **Security Tests**
```javascript
// Missing tests for:
- ACL enforcement
- CLP (Class Level Permissions)
- Protected fields
- Password hashing
- Session token validation
```

#### C. **Live Query Support**
```javascript
// Missing tests for:
- Live Query subscriptions (if supported)
- Real-time updates
```

---

### 🔴 **5. Missing Oracle-Specific Tests**

#### A. **Oracle-Specific Features**
```javascript
// Missing tests for:
- TNS_ADMIN environment variable
- Oracle Wallet authentication
- RAC (Real Application Clusters) support
- Connection string variations
- Oracle-specific data types (CLOB, BLOB, etc.)
- Sequence handling for auto-increment
```

#### B. **Oracle Limitations**
```javascript
// Missing tests for:
- 30-character identifier limit (table/column names)
- Case sensitivity handling
- Reserved word handling
- Maximum SQL statement size
- Bind variable limits
```

---

## Test Coverage Comparison

| Feature Category | MongoDB | PostgreSQL | Oracle | Status |
|-----------------|---------|------------|--------|--------|
| **Config Parser** | ✅ | ✅ | ✅ | Complete |
| **Init Options** | ✅ | ✅ | ✅ | Complete |
| **Basic CRUD** | ✅ | ✅ | ✅ | Complete |
| **Query Operators** | ✅ | ✅ | ⚠️ | Partial |
| **Aggregation** | ✅ | ✅ | ❌ | Missing |
| **Regex Queries** | ✅ | ✅ | ❌ | Missing |
| **Relations** | ✅ | ✅ | ❌ | Missing |
| **GeoQueries** | ✅ | ✅ | ⚠️ | Partial |
| **Full-Text Search** | ✅ | ⚠️ | ❌ | Missing |
| **Indexes** | ✅ | ⚠️ | ❌ | Missing |
| **Transactions** | ✅ | ✅ | ❌ | Missing |
| **ACL/Security** | ✅ | ✅ | ❌ | Missing |
| **Edge Cases** | ✅ | ⚠️ | ❌ | Missing |
| **Error Handling** | ✅ | ⚠️ | ⚠️ | Minimal |

**Legend:**
- ✅ = Well tested
- ⚠️ = Partially tested
- ❌ = Not tested / Missing

---

## Recommended Testing Priority

### 🔥 **Priority 1: Critical (Do First)**

1. **Run all existing tests with Oracle** to identify failures
   ```bash
   PARSE_SERVER_TEST_DB=oracle npm run testonly
   ```

2. **Fix or exclude failing generic tests**
   - Test the 11 postgres-excluded tests
   - Add oracle to exclusions where needed

3. **Add missing query operator tests**
   - $exists
   - $regex (critical for many apps)
   - $select / $dontSelect

### 🟡 **Priority 2: Important (Do Soon)**

4. **Add relation/pointer tests**
   - $inQuery
   - $notInQuery
   - Pointer queries

5. **Add aggregate query tests**
   - Basic aggregation pipeline
   - Group, match, project

6. **Add security tests**
   - ACL enforcement
   - CLP validation
   - Protected fields

### 🟢 **Priority 3: Nice to Have**

7. **Add edge case tests**
   - Large data handling
   - Unicode/special characters
   - Connection pool stress tests

8. **Add Oracle-specific tests**
   - TNS alias variations
   - Oracle Wallet
   - Identifier length limits

9. **Add full-text search tests**
   - If Oracle text search is implemented

---

## How to Run Tests

### Run ALL tests with Oracle:
```bash
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://system:oracle@localhost:1521/FREEPDB1 \
npm run testonly
```

### Run ONLY Oracle-specific tests:
```bash
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/Oracle*.spec.js
```

### Run generic tests to find failures:
```bash
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseQuery.spec.js
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseObject.spec.js
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/Schema.spec.js
```

### Compare with PostgreSQL:
```bash
# Run same test on both databases
PARSE_SERVER_TEST_DB=postgres npm run testonly -- spec/ParseQuery.spec.js
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseQuery.spec.js
```

---

## Next Steps

### Immediate Actions:

1. ✅ **Review this analysis**
2. 🔥 **Run full test suite with Oracle** and document failures
3. 🔥 **Create test exclusion list** for Oracle (if needed)
4. 🔥 **Add missing critical tests** (Priority 1 items)
5. 🟡 **Incrementally add Priority 2 tests**
6. 📝 **Document Oracle-specific limitations** in README

### Test Development Workflow:

1. **Copy test patterns from PostgreSQL tests** (they're similar to Oracle)
2. **Adapt for Oracle-specific behavior** where needed
3. **Use `describe_only_db('oracle')` for Oracle-specific tests**
4. **Use `it_exclude_dbs(['oracle'])` for unsupported features**

---

## Example: Adding Missing Tests

### Template for adding a missing test:

```javascript
// spec/OracleStorageAdapter.spec.js

describe_only_db('oracle')('OracleStorageAdapter - Advanced Queries', () => {
  beforeEach(async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });
  });

  // Add $exists operator test
  it('should handle $exists operator', async () => {
    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const obj1 = new Parse.Object('ExistsClass');
    obj1.set('name', 'HasField');
    obj1.set('optional', 'value');
    await obj1.save();

    const obj2 = new Parse.Object('ExistsClass');
    obj2.set('name', 'NoField');
    await obj2.save();

    // Query for objects where 'optional' exists
    const query = new Parse.Query('ExistsClass');
    query.exists('optional');
    const results = await query.find();

    expect(results.length).toBe(1);
    expect(results[0].get('name')).toBe('HasField');
  });

  // Add $regex operator test
  it('should handle $regex queries', async () => {
    // ... similar pattern
  });
});
```

---

## Conclusion

**Current State:**
- ✅ Oracle adapter has **basic functionality tested**
- ✅ Config parsing and initialization are **well covered**
- ⚠️ **~60% of advanced features are untested**
- ❌ **Many generic tests may fail with Oracle**

**Required Work:**
- 🔥 **~50-100 additional test cases needed** for parity with MongoDB/PostgreSQL
- 🔥 **Test all 11 postgres-excluded tests** with Oracle
- 🔥 **Add critical missing query operators** ($exists, $regex, relations)
- 🟡 **Add security and ACL tests**
- 🟢 **Add edge cases and Oracle-specific tests**

**Estimated Effort:**
- Priority 1: **2-3 days** (critical tests)
- Priority 2: **3-5 days** (important tests)
- Priority 3: **2-3 days** (nice-to-have tests)
- **Total: ~1-2 weeks** for comprehensive coverage

---

**Generated:** $(date)
**Author:** AI Analysis
**Project:** Parse Server Oracle Adapter

