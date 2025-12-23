# Oracle Adapter Debugging Summary

**Date:** December 23, 2025  
**Session:** Initial Testing & Debugging

---

## 🎯 Progress Summary

### ✅ **Fixed Issues:**

1. **Pool Alias Conflict** ✅ **FIXED**
   - **Problem:** Hardcoded pool alias `'parseServer'` caused conflicts when creating multiple adapter instances
   - **Solution:** Use unique pool aliases: `parseServer_${Date.now()}_${Math.random()}`
   - **File:** `src/Adapters/Storage/Oracle/OracleClient.js`
   - **Status:** Working perfectly

2. **Split Error on Sort Keys** ✅ **PARTIALLY FIXED**
   - **Problem:** `Object.keys(sort)` could include undefined/null keys
   - **Solution:** Added `.filter(key => key != null && key !== '')`
   - **File:** `src/Adapters/Storage/Oracle/OracleStorageAdapter.js` line 2074
   - **Status:** Reduced errors significantly

3. **Split Error on Keys Parameter** ✅ **FIXED**
   - **Problem:** `keys` array could contain null values
   - **Solution:** Added `.filter(key => key != null)`
   - **File:** `src/Adapters/Storage/Oracle/OracleStorageAdapter.js` line 2093
   - **Status:** Working

4. **Schema.fields Undefined** ✅ **FIXED**
   - **Problem:** `oracleObjectToParseObject` didn't check if `schema.fields` exists
   - **Solution:** Added null check before accessing `schema.fields`
   - **File:** `src/Adapters/Storage/Oracle/OracleStorageAdapter.js` line 2145
   - **Status:** Working

---

## ❌ **Remaining Issues:**

### Issue #1: INVALID_JSON Error (Parse Error 107)
**Status:** 🔴 **BLOCKING**  
**Severity:** High  
**Tests Affected:** 3 tests in OracleInitOptions, 4+ tests in OracleStorageAdapter

**Error Message:**
```
Error: Could not add field [fieldName]
error properties: Object({ code: 107 })
```

**What is Error 107?**
- Parse.Error.INVALID_JSON
- Indicates JSON parsing/serialization issue

**Possible Causes:**
1. Schema JSON serialization/deserialization issue in `addFieldIfNotExists`
2. Field type mismatch when adding fields dynamically
3. CLOB handling for JSON fields in Oracle
4. Schema not being properly saved/retrieved from `_SCHEMA` table

**Where It Happens:**
- When trying to save objects with new fields
- During dynamic schema creation
- In `addFieldIfNotExists` method (line 1385)

**Next Steps to Debug:**
1. Add logging to `addFieldIfNotExists` to see exact error
2. Check if `_SCHEMA` table is being created properly
3. Verify JSON serialization of schema objects
4. Test CLOB read/write for schema storage

---

### Issue #2: Remaining Split Errors
**Status:** 🟡 **INTERMITTENT**  
**Severity:** Medium  
**Tests Affected:** 1 test in OracleInitOptions, 15+ tests in OracleStorageAdapter

**Error Message:**
```
TypeError: Cannot read properties of undefined (reading 'split')
```

**What's Fixed:**
- Sort keys filtering ✅
- Keys parameter filtering ✅
- Schema.fields check ✅

**What Might Still Cause It:**
1. Field names in `buildWhereClause` when schema is incomplete
2. Dot notation handling in queries with missing schema
3. Transform functions receiving undefined from incomplete schemas

**Likely Root Cause:**
- The split errors are probably a **symptom** of Issue #1 (INVALID_JSON)
- When schema creation fails, subsequent operations try to use undefined field names
- This cascades into split errors

**Next Steps:**
1. Fix Issue #1 first (INVALID_JSON)
2. Re-test to see if split errors disappear
3. If they persist, add more null checks in transform functions

---

### Issue #3: Empty Table Creation
**Status:** 🟡 **MINOR**  
**Severity:** Low  
**Tests Affected:** 1 test

**Error Message:**
```
Error: ORA-00931: missing identifier
```

**Test:** "Create a table without columns and upgrade with columns"

**Problem:**
- Oracle doesn't allow creating tables with zero columns
- SQL: `CREATE TABLE "EmptyTable" ()` is invalid in Oracle

**Solution:**
- Either skip this test for Oracle (it's an edge case)
- Or create table with a dummy column that gets removed later

---

## 📊 Current Test Status

### OracleConfigParser
- **Status:** ✅ **100% PASSING**
- **Tests:** 9/9 passing
- **Time:** ~3 seconds

### OracleInitOptions
- **Status:** ⚠️ **40% PASSING**
- **Tests:** 2/5 passing
- **Passing:**
  - ✅ should handle schema cache TTL option
  - ✅ should handle enableSchemaHooks option
- **Failing:**
  - ❌ should create server with default databaseOptions (INVALID_JSON)
  - ❌ should create server with custom pool options (INVALID_JSON)
  - ❌ should create server using oracledb uri (split error)

### OracleStorageAdapter
- **Status:** ⚠️ **23% PASSING**
- **Tests:** 6/26 passing
- **Passing:**
  - ✅ handleShutdown tests (2)
  - ✅ schemaUpgrade tests (2)
  - ✅ getClass tests (2)
- **Failing:**
  - ❌ 20 tests with split errors or INVALID_JSON errors

### Overall Progress
- **Total Tests:** 40
- **Passing:** 17 (42.5%)
- **Failing:** 23 (57.5%)

---

## 🔍 Debugging Strategy

### Priority 1: Fix INVALID_JSON Error

**Step 1: Add Debugging to addFieldIfNotExists**
```javascript
// In addFieldIfNotExists method
console.log('DEBUG: Adding field', fieldName, 'type:', JSON.stringify(type));
console.log('DEBUG: Schema before:', JSON.stringify(existingSchema));
```

**Step 2: Check _SCHEMA Table**
```sql
-- Connect to Oracle
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1

-- Check if _SCHEMA exists
SELECT COUNT(*) FROM user_tables WHERE table_name = '_SCHEMA';

-- Check _SCHEMA contents
SELECT * FROM "_SCHEMA";

-- Check schema column type
DESC "_SCHEMA";
```

**Step 3: Test CLOB Handling**
```javascript
// Test if CLOB read/write works
const testSchema = { fields: { test: { type: 'String' } } };
const json = JSON.stringify(testSchema);
console.log('JSON length:', json.length);
// Insert and retrieve to test CLOB
```

### Priority 2: Verify Schema Creation Flow

**Check the flow:**
1. `performInitialization` → calls `_ensureSchemaCollectionExists`
2. `createObject` → triggers `addFieldIfNotExists` if field missing
3. `addFieldIfNotExists` → updates `_SCHEMA` table
4. Schema retrieval → parses JSON from CLOB

**Potential Issue:**
- CLOB might not be properly read/written
- JSON.parse might fail on CLOB data
- Schema might not be committed properly

### Priority 3: Compare with PostgreSQL

**PostgreSQL uses:**
- `jsonb` type for schema storage
- Direct JSON operations

**Oracle uses:**
- `CLOB` type for schema storage
- Manual JSON stringify/parse

**Key Difference:**
- Oracle CLOB handling might need special care
- Check if CLOB is being read as string properly

---

## 🛠️ Quick Fixes to Try

### Fix #1: Ensure CLOB is Read as String
```javascript
// In getClass and addFieldIfNotExists
const schemaData = result.rows[0].schema;
const schema = typeof schemaData === 'string' 
  ? JSON.parse(schemaData)
  : (schemaData.toString ? JSON.parse(schemaData.toString()) : schemaData);
```

### Fix #2: Add Better Error Handling
```javascript
// In addFieldIfNotExists
try {
  const existingSchema = JSON.parse(schemaResult.rows[0].schema);
  // ... rest of code
} catch (parseError) {
  console.error('Failed to parse schema JSON:', parseError);
  console.error('Schema data:', schemaResult.rows[0].schema);
  throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Schema parse error');
}
```

### Fix #3: Verify Schema Table Creation
```javascript
// In _ensureSchemaCollectionExists
await conn.execute(`
  CREATE TABLE "_SCHEMA" (
    "className" VARCHAR2(120) PRIMARY KEY,
    "schema" CLOB CHECK ("schema" IS JSON), -- Add JSON constraint
    "isParseClass" NUMBER(1)
  )
`);
```

---

## 📝 Test Commands

### Run Specific Tests
```bash
# Config parser (working)
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly -- spec/OracleConfigParser.spec.js

# Init options (3 failures)
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly -- spec/OracleInitOptions.spec.js

# Storage adapter (20 failures)
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly -- spec/OracleStorageAdapter.spec.js
```

### Check Oracle Database
```bash
# Connect to SQL*Plus
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1

# Check tables
SELECT table_name FROM user_tables ORDER BY table_name;

# Check _SCHEMA
SELECT * FROM "_SCHEMA";

# Check test tables
SELECT table_name FROM user_tables WHERE table_name LIKE 'test_%';

# Clean up
BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name LIKE 'test_%') LOOP
    EXECUTE IMMEDIATE 'DROP TABLE "' || t.table_name || '" CASCADE CONSTRAINTS';
  END LOOP;
END;
/
```

---

## 🎯 Next Actions

1. **Immediate:** Debug the INVALID_JSON error
   - Add logging to `addFieldIfNotExists`
   - Check `_SCHEMA` table structure and contents
   - Verify CLOB read/write operations

2. **Short-term:** Fix schema handling
   - Ensure JSON serialization works properly
   - Add better error messages
   - Test with simple schema first

3. **Medium-term:** Complete remaining tests
   - Fix any remaining split errors
   - Handle edge cases (empty tables, etc.)
   - Add missing query operators

---

## 📚 Files Modified

1. ✅ `src/Adapters/Storage/Oracle/OracleClient.js`
   - Fixed pool alias conflict

2. ✅ `src/Adapters/Storage/Oracle/OracleStorageAdapter.js`
   - Fixed sort keys filtering (line 2074)
   - Fixed keys parameter filtering (line 2093)
   - Fixed schema.fields check (line 2145)

3. 📝 **Need to modify:**
   - `src/Adapters/Storage/Oracle/OracleStorageAdapter.js`
     - Add better error handling in `addFieldIfNotExists`
     - Add logging for schema operations
     - Fix CLOB handling if needed

---

## 💡 Lessons Learned

1. **Unique Pool Aliases:** Essential for test scenarios with multiple adapter instances
2. **Null Checks:** Always filter arrays before using string methods
3. **Schema Validation:** Need robust null/undefined checks throughout
4. **CLOB Handling:** Oracle's CLOB type needs special attention for JSON
5. **Error Messages:** Parse error codes can be cryptic, need better logging

---

## 🚀 Estimated Time to Fix

- **INVALID_JSON error:** 2-4 hours (debugging + fix)
- **Remaining split errors:** 1 hour (likely fixed by above)
- **Edge cases:** 1-2 hours
- **Total:** ~4-7 hours to get to 80%+ passing tests

---

**Last Updated:** December 23, 2025  
**Next Review:** After fixing INVALID_JSON error  
**Status:** In Progress - Debugging Phase

