# Oracle Adapter Test Results - Initial Run

**Date:** December 23, 2025  
**Oracle Version:** Oracle Free 23c (compatible with 19c)  
**Parse Server Version:** 7.5.4

---

## ✅ Setup Status

### Docker Oracle Container
- **Status:** ✅ Running successfully
- **Container:** `parse-oracle-19c`
- **Image:** `gvenzl/oracle-free:23-slim`
- **Port:** 1521
- **Service:** FREEPDB1
- **User:** parseserver
- **Connection String:** `oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1`

### Database Connection
- **Status:** ✅ Connected successfully
- **Connection Test:** Passed
- **SQL*Plus Access:** Working

---

## 📊 Test Results Summary

| Test Suite | Total | Passed | Failed | Status |
|------------|-------|--------|--------|--------|
| **OracleConfigParser** | 9 | 9 | 0 | ✅ **PASS** |
| **OracleInitOptions** | 5 | 2 | 3 | ❌ **FAIL** |
| **OracleStorageAdapter** | - | - | - | ⏸️ **NOT RUN** |
| **Generic Tests** | - | - | - | ⏸️ **NOT RUN** |

---

## ✅ Test Suite 1: OracleConfigParser (PASSED)

### All 9 tests passing:

```
✓ creates a map from a query string
✓ parses standard connection string correctly
✓ parses TNS alias connection string correctly
✓ uses default port 1521 when not specified
✓ handles URL encoded username and password
✓ removes user/password when externalAuth is true
✓ sets poolMin to 0 if not a number
✓ sets poolMax to 4 if not a number
✓ creates a db options map from a query string
```

**Status:** ✅ **All configuration parsing works correctly**

**Time:** 2.917 seconds  
**Result:** 9/9 specs passed

---

## ❌ Test Suite 2: OracleInitOptions (FAILED)

### Results: 2 passed, 3 failed

#### ✅ Passing Tests (2):
1. `should handle schema cache TTL option`
2. `should handle enableSchemaHooks option`

#### ❌ Failing Tests (3):
1. `should create server with default databaseOptions`
2. `should create server using oracledb uri`
3. `should create server with custom pool options`

### Root Cause: Connection Pool Alias Conflict

**Error:**
```
Error: NJS-046: pool alias "parseServer" already exists in the connection pool cache
```

**Problem:**
The Oracle adapter hardcodes the pool alias to `'parseServer'` in `OracleClient.js`:

```javascript
poolAlias: dbOptions.poolAlias || 'parseServer',
```

When multiple tests run sequentially and create new adapter instances, they try to create pools with the same alias, causing a conflict.

**Location:** `src/Adapters/Storage/Oracle/OracleClient.js:40`

**Impact:** 
- Tests that create multiple server instances fail
- Cannot reconfigure server during tests
- Affects integration testing scenarios

---

## 🐛 Issues Found

### 🔴 Issue #1: Connection Pool Alias Conflict (Critical)

**Severity:** High  
**Status:** Blocking tests  
**Test Impact:** 3 tests failing

**Description:**
The pool alias is hardcoded to `'parseServer'`, preventing multiple pool creations in test scenarios.

**Files Affected:**
- `src/Adapters/Storage/Oracle/OracleClient.js`
- `spec/OracleInitOptions.spec.js`

**Solutions:**

#### Option A: Check and reuse existing pools (Recommended)
```javascript
export async function createClient(uri, databaseOptions) {
  // ... existing code ...
  
  const poolAlias = dbOptions.poolAlias || 'parseServer';
  
  // Check if pool already exists
  try {
    const existingPool = oracledb.getPool(poolAlias);
    if (existingPool) {
      // Close existing pool before creating new one
      await existingPool.close(0);
    }
  } catch (err) {
    // Pool doesn't exist, continue
  }
  
  poolConfig.poolAlias = poolAlias;
  
  // Create the connection pool
  const pool = await oracledb.createPool(poolConfig);
  // ...
}
```

#### Option B: Use unique pool aliases
```javascript
poolAlias: dbOptions.poolAlias || `parseServer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
```

#### Option C: Implement proper cleanup in tests
```javascript
// In spec/OracleInitOptions.spec.js
afterEach(async () => {
  // Close all Oracle pools
  const oracledb = require('oracledb');
  try {
    await oracledb.getPool('parseServer').close(0);
  } catch (e) {
    // Pool already closed
  }
});
```

**Recommendation:** Implement Option A (check and close existing pools) as it's the most robust solution that works for both test and production scenarios.

---

### ⚠️ Issue #2: Missing Cleanup in Test Suite

**Severity:** Medium  
**Status:** Contributing to failures

**Description:**
The `OracleInitOptions.spec.js` doesn't properly clean up connection pools between tests, leading to pool alias conflicts.

**Solution:**
Add proper cleanup in `afterEach` or `afterAll` hooks:

```javascript
afterEach(async () => {
  try {
    const oracledb = require('oracledb');
    const pool = oracledb.getPool('parseServer');
    await pool.close(0); // 0 = force close immediately
  } catch (err) {
    // Pool already closed or doesn't exist
  }
});
```

---

## 📋 Next Steps

### Immediate Actions (Priority 1)

1. **Fix Pool Alias Conflict**
   - [ ] Implement solution in `OracleClient.js`
   - [ ] Add pool cleanup logic
   - [ ] Test the fix

2. **Re-run OracleInitOptions Tests**
   ```bash
   PARSE_SERVER_TEST_DB=oracle \
   PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
   npm run testonly -- spec/OracleInitOptions.spec.js
   ```

3. **Run OracleStorageAdapter Tests**
   ```bash
   PARSE_SERVER_TEST_DB=oracle \
   PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
   npm run testonly -- spec/OracleStorageAdapter.spec.js
   ```

### Follow-up Actions (Priority 2)

4. **Test Generic Test Suites**
   - [ ] Run ParseQuery tests
   - [ ] Run Schema tests
   - [ ] Run ParseObject tests
   - [ ] Document any failures

5. **Test Postgres-Excluded Tests**
   - [ ] Test the 11 postgres-excluded tests with Oracle
   - [ ] Add oracle to exclusions where needed

6. **Add Missing Test Coverage**
   - [ ] Add $exists operator tests
   - [ ] Add $regex operator tests
   - [ ] Add relation query tests

---

## 🔧 Temporary Workaround

While the fix is being implemented, you can run tests individually with cleanup:

```bash
# Test 1
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly -- spec/OracleConfigParser.spec.js

# Restart Docker to clean pools
docker restart parse-oracle-19c
sleep 10

# Test 2
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly -- spec/OracleInitOptions.spec.js
```

---

## 📊 Success Criteria

### Minimum Viable
- ✅ OracleConfigParser all passing
- ❌ OracleInitOptions all passing (3 failures)
- ⏸️ OracleStorageAdapter all passing (not yet run)
- ⏸️ No regressions in generic tests (not yet run)

### Current Progress: ~20%
- Config parsing: ✅ Complete
- Initialization: ❌ Blocked by pool issue
- Storage operations: ⏸️ Pending
- Query operations: ⏸️ Pending
- Generic compatibility: ⏸️ Pending

---

## 📝 Test Commands Reference

```bash
# Set up environment
export PARSE_SERVER_TEST_DB=oracle
export PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1

# Run specific test suites
npm run testonly -- spec/OracleConfigParser.spec.js
npm run testonly -- spec/OracleInitOptions.spec.js
npm run testonly -- spec/OracleStorageAdapter.spec.js

# Run all Oracle tests
npm run testonly -- spec/Oracle*.spec.js

# Run with verbose output
VERBOSE=1 npm run testonly -- spec/Oracle*.spec.js

# Docker management
docker logs -f parse-oracle-19c          # View logs
docker restart parse-oracle-19c          # Restart Oracle
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1  # Connect SQL
```

---

## 🎯 Conclusion

### What Works ✅
- Oracle Docker setup
- Database connection
- Configuration parsing
- Basic adapter initialization (without pool conflicts)

### What Needs Fixing ❌
- Connection pool management (critical)
- Test cleanup/isolation
- Unknown issues in storage adapter tests (not yet run)
- Unknown issues in generic tests (not yet run)

### Estimated Effort
- **Pool fix:** 1-2 hours
- **Test cleanup:** 1 hour
- **Storage adapter testing:** 2-4 hours
- **Generic test validation:** 4-8 hours
- **Total:** ~1-2 days for basic working test suite

---

**Generated:** December 23, 2025  
**Next Update:** After fixing pool alias issue  
**Status:** In Progress - Blocked by Issue #1

