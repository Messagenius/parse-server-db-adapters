# Oracle Adapter Test Checklist

Quick reference for testing the Oracle adapter implementation.

## 🔥 Priority 1: Critical Tests (Do First)

### 1. Run Existing Test Suite
```bash
# Run all tests with Oracle
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://system:oracle@localhost:1521/FREEPDB1 \
npm run testonly

# Expected: Some failures, document them
```

### 2. Test PostgreSQL-Excluded Tests
These 11 tests exclude postgres but not oracle - they may fail:

- [ ] `spec/schemas.spec.js` - 'get indexes on startup'
- [ ] `spec/schemas.spec.js` - 'get compound indexes on startup'
- [ ] `spec/schemas.spec.js` - 'cannot update to duplicate value on unique index'
- [ ] `spec/RestQuery.spec.js` - 'query for user w/ legacy credentials without masterKey'
- [ ] `spec/RestQuery.spec.js` - 'query for user w/ legacy credentials with masterKey'
- [ ] `spec/RestQuery.spec.js` - 'query with include'
- [ ] `spec/ParseUser.spec.js` - 'should cleanup null authData keys'
- [ ] `spec/ParseUser.spec.js` - 'should not serve null authData keys'
- [ ] `spec/ParseQuery.spec.js` - 'querying for null value'
- [ ] `spec/ParseQuery.Aggregate.spec.js` - 'group and multiply transform'
- [ ] `spec/ParseQuery.Aggregate.spec.js` - 'project and multiply transform'

**Action:** For each failing test, either fix Oracle adapter OR add to exclusion list.

### 3. Add Critical Missing Query Operators

- [ ] **$exists operator**
  ```javascript
  query.exists('fieldName');
  query.doesNotExist('fieldName');
  ```

- [ ] **$regex operator**
  ```javascript
  query.matches('name', /^prefix/);
  query.matches('name', /pattern/i); // case insensitive
  ```

- [ ] **$select / $dontSelect**
  ```javascript
  query.select('field1', 'field2');
  query.exclude('sensitiveField');
  ```

## 🟡 Priority 2: Important Tests

### 4. Relation & Pointer Queries

- [ ] **Pointer queries**
  ```javascript
  query.equalTo('pointer', otherObject);
  query.include('pointer');
  ```

- [ ] **$inQuery**
  ```javascript
  const innerQuery = new Parse.Query('OtherClass');
  query.matchesQuery('pointer', innerQuery);
  ```

- [ ] **$notInQuery**
  ```javascript
  query.doesNotMatchQuery('pointer', innerQuery);
  ```

- [ ] **$relatedTo**
  ```javascript
  query.relatedTo('relation', object);
  ```

### 5. Aggregate Queries

- [ ] **Basic aggregation**
  ```javascript
  const pipeline = [
    { group: { objectId: '$name' } },
    { match: { score: { $gt: 100 } } }
  ];
  ```

- [ ] **$group operations**
- [ ] **$match operations**
- [ ] **$project operations**
- [ ] **$sort in aggregation**
- [ ] **$limit in aggregation**

### 6. Security & ACL Tests

- [ ] **ACL enforcement**
  ```javascript
  const acl = new Parse.ACL(user);
  acl.setPublicReadAccess(false);
  object.setACL(acl);
  ```

- [ ] **CLP (Class Level Permissions)**
- [ ] **Protected fields**
- [ ] **User authentication queries**

## 🟢 Priority 3: Nice to Have

### 7. Advanced Array Operations

- [ ] **$size operator**
  ```javascript
  query.sizeEqualTo('arrayField', 3);
  ```

- [ ] **$elemMatch**
  ```javascript
  query.matches('arrayField', { $elemMatch: { score: { $gt: 80 } } });
  ```

- [ ] **Array of pointers**

### 8. Edge Cases

- [ ] **Large numbers** (beyond JavaScript safe integer)
- [ ] **Unicode strings** (emoji, special characters)
- [ ] **Binary data** (Bytes type)
- [ ] **Large JSON objects** (test limits)
- [ ] **Empty strings vs null**
- [ ] **Undefined handling**

### 9. Connection & Error Handling

- [ ] **Connection timeout**
- [ ] **Pool exhaustion**
- [ ] **Retry logic**
- [ ] **Concurrent connections**
- [ ] **Graceful shutdown**

### 10. Oracle-Specific Features

- [ ] **TNS alias connections**
- [ ] **Oracle Wallet authentication**
- [ ] **30-character identifier limit**
- [ ] **Case sensitivity**
- [ ] **Reserved words**
- [ ] **CLOB/BLOB handling**

## 📊 Test Coverage Status

| Category | Status | Tests Passing | Notes |
|----------|--------|---------------|-------|
| Config Parser | ✅ Complete | - / - | All tests pass |
| Init Options | ✅ Complete | - / - | All tests pass |
| Basic CRUD | ✅ Complete | - / - | Create, Read, Update, Delete |
| Simple Queries | ✅ Complete | - / - | $gt, $lt, $in, $nin |
| GeoQueries | ⚠️ Partial | - / - | Basic geo, missing polygon |
| Regex | ❌ Missing | 0 / ? | Not tested |
| Relations | ❌ Missing | 0 / ? | Not tested |
| Aggregation | ❌ Missing | 0 / ? | Not tested |
| Security/ACL | ❌ Missing | 0 / ? | Not tested |
| Edge Cases | ❌ Missing | 0 / ? | Not tested |

## 🚀 Quick Test Commands

### Run specific test files
```bash
# Oracle-specific tests only
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/Oracle*.spec.js

# Query tests
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseQuery.spec.js

# Schema tests
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/Schema.spec.js

# User tests
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseUser.spec.js

# Aggregate tests
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseQuery.Aggregate.spec.js
```

### Compare with PostgreSQL
```bash
# Run same test on both
PARSE_SERVER_TEST_DB=postgres npm run testonly -- spec/ParseQuery.spec.js
PARSE_SERVER_TEST_DB=oracle npm run testonly -- spec/ParseQuery.spec.js
```

### Run with verbose output
```bash
VERBOSE=1 PARSE_SERVER_TEST_DB=oracle npm run testonly
```

## 📝 Test Development Template

```javascript
// spec/OracleStorageAdapter.spec.js

describe_only_db('oracle')('OracleStorageAdapter - [Feature Name]', () => {
  let adapter;
  
  beforeEach(async () => {
    const config = Config.get('test');
    adapter = config.database.adapter;
    await adapter.deleteAllClasses();
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });
    
    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });
  });

  it('should [test description]', async () => {
    // Arrange
    const obj = new Parse.Object('TestClass');
    obj.set('field', 'value');
    await obj.save();

    // Act
    const query = new Parse.Query('TestClass');
    // ... query operations
    const results = await query.find();

    // Assert
    expect(results.length).toBe(1);
    expect(results[0].get('field')).toBe('value');
  });
});
```

## 🎯 Success Criteria

### Minimum Viable Test Coverage
- ✅ All existing tests pass with Oracle
- ✅ All postgres-excluded tests either pass or are excluded
- ✅ Critical query operators tested ($exists, $regex, $select)
- ✅ Basic relation queries tested
- ✅ Basic ACL enforcement tested

### Comprehensive Test Coverage
- ✅ All Priority 1 items complete
- ✅ All Priority 2 items complete
- ✅ 80%+ of Priority 3 items complete
- ✅ Test coverage matches PostgreSQL adapter
- ✅ Oracle-specific features documented and tested

## 📚 Resources

- **Test Helper Functions:** `spec/helper.js`
- **MongoDB Tests (reference):** `spec/MongoStorageAdapter.spec.js` (686 lines)
- **PostgreSQL Tests (reference):** `spec/PostgresStorageAdapter.spec.js` (591 lines)
- **Oracle Tests (current):** `spec/OracleStorageAdapter.spec.js` (715 lines)

## 🐛 Known Issues / Limitations

Document any known Oracle limitations here:

- [ ] Issue 1: ...
- [ ] Issue 2: ...
- [ ] Issue 3: ...

---

**Last Updated:** [Date]
**Status:** In Progress
**Next Review:** After Priority 1 completion

