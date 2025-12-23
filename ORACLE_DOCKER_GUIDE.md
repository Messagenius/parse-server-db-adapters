# Oracle 19c Docker Setup Guide for Parse Server Testing

Complete guide to set up and test Oracle Database with Parse Server.

---

## Quick Start (Automated)

### Option 1: Use the Setup Script (Recommended)

```bash
# Make script executable
chmod +x docker-oracle-setup.sh

# Run the setup
./docker-oracle-setup.sh
```

The script will:
- ✅ Pull the Oracle image
- ✅ Start the container
- ✅ Wait for database initialization
- ✅ Test the connection
- ✅ Display connection details

---

## Manual Setup (Step by Step)

### Step 1: Choose Oracle Docker Image

We'll use **gvenzl/oracle-free** (community-maintained, easy to use):

```bash
# Pull Oracle Free 23c (recommended for testing)
docker pull gvenzl/oracle-free:23-slim

# Alternative: Oracle XE 21c
docker pull gvenzl/oracle-xe:21-slim

# Alternative: Oracle XE 18c (closest to 19c)
docker pull gvenzl/oracle-xe:18-slim
```

**Note:** Oracle 19c Enterprise is available from Oracle Container Registry but requires:
- Accepting Oracle license terms
- Logging into container-registry.oracle.com
- Much larger download (~4GB vs ~1GB)

For testing purposes, Oracle Free/XE is sufficient.

---

### Step 2: Start Oracle Container

```bash
docker run -d \
  --name parse-oracle-19c \
  -p 1521:1521 \
  -e ORACLE_PASSWORD=ParseTest123! \
  -e APP_USER=parseserver \
  -e APP_USER_PASSWORD=ParseTest123! \
  gvenzl/oracle-free:23-slim
```

**Parameters explained:**
- `-d`: Run in background
- `--name`: Container name
- `-p 1521:1521`: Expose Oracle port
- `-e ORACLE_PASSWORD`: SYS/SYSTEM password
- `-e APP_USER`: Create application user (parseserver)
- `-e APP_USER_PASSWORD`: Application user password

---

### Step 3: Wait for Database to Initialize

**First time startup takes 2-5 minutes.**

Monitor the startup:
```bash
docker logs -f parse-oracle-19c
```

Wait for this message:
```
DATABASE IS READY TO USE!
```

Press `Ctrl+C` to exit log view.

---

### Step 4: Verify Database Connection

#### Test with SQL*Plus inside container:
```bash
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1
```

You should see:
```
SQL*Plus: Release 23.0.0.0.0 - Production
...
Connected to:
Oracle Database 23c Free Release 23.0.0.0.0

SQL>
```

Test a query:
```sql
SELECT 'Hello Oracle!' FROM dual;
```

Exit:
```sql
EXIT;
```

---

### Step 5: Configure Parse Server for Oracle

#### Option A: Using Environment Variables

```bash
# Set environment variables
export PARSE_SERVER_TEST_DB=oracle
export PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1

# Run tests
npm run testonly
```

#### Option B: Using the .env file

```bash
# Source the environment file
source .env.oracle.test

# Run tests
npm run testonly
```

#### Option C: Inline with test command

```bash
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly
```

---

## Testing the Oracle Adapter

### Run All Tests with Oracle

```bash
# Source environment
source .env.oracle.test

# Run all tests
npm run testonly

# Or inline:
PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly
```

### Run Oracle-Specific Tests Only

```bash
source .env.oracle.test
npm run testonly -- spec/Oracle*.spec.js
```

### Run Specific Test Files

```bash
source .env.oracle.test

# Test queries
npm run testonly -- spec/ParseQuery.spec.js

# Test schemas
npm run testonly -- spec/Schema.spec.js

# Test objects
npm run testonly -- spec/ParseObject.spec.js

# Test users
npm run testonly -- spec/ParseUser.spec.js
```

### Run with Verbose Output

```bash
VERBOSE=1 PARSE_SERVER_TEST_DB=oracle \
PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1 \
npm run testonly
```

---

## Docker Management Commands

### Check Container Status
```bash
docker ps -a | grep oracle
```

### View Logs
```bash
# Follow logs (live)
docker logs -f parse-oracle-19c

# Last 100 lines
docker logs --tail 100 parse-oracle-19c

# Since 5 minutes ago
docker logs --since 5m parse-oracle-19c
```

### Stop Container
```bash
docker stop parse-oracle-19c
```

### Start Container
```bash
docker start parse-oracle-19c
```

### Restart Container
```bash
docker restart parse-oracle-19c
```

### Remove Container
```bash
# Stop and remove
docker rm -f parse-oracle-19c

# Remove image (optional)
docker rmi gvenzl/oracle-free:23-slim
```

### Container Resource Usage
```bash
docker stats parse-oracle-19c
```

---

## Database Administration

### Connect as Application User
```bash
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1
```

### Connect as SYSTEM (admin)
```bash
docker exec -it parse-oracle-19c sqlplus system/ParseTest123!@//localhost:1521/FREEPDB1
```

### Useful SQL Queries

#### List all tables
```sql
SELECT table_name FROM user_tables ORDER BY table_name;
```

#### Check table structure
```sql
DESCRIBE table_name;
```

#### List all indexes
```sql
SELECT index_name, table_name FROM user_indexes ORDER BY table_name;
```

#### Check database version
```sql
SELECT * FROM v$version;
```

#### Check database size
```sql
SELECT 
  SUM(bytes)/1024/1024 AS size_mb 
FROM user_segments;
```

#### Drop all Parse Server test tables
```sql
BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name LIKE 'test_%') LOOP
    EXECUTE IMMEDIATE 'DROP TABLE ' || t.table_name || ' CASCADE CONSTRAINTS';
  END LOOP;
END;
/
```

---

## Troubleshooting

### Container won't start
```bash
# Check logs for errors
docker logs parse-oracle-19c

# Check port conflicts
lsof -i :1521

# Remove and recreate
docker rm -f parse-oracle-19c
./docker-oracle-setup.sh
```

### Connection refused
```bash
# Make sure container is running
docker ps | grep oracle

# Check if database is ready
docker logs parse-oracle-19c | grep "DATABASE IS READY"

# Wait longer (database might still be initializing)
sleep 30
```

### Tests timing out
```bash
# Increase timeout
export PARSE_SERVER_TEST_TIMEOUT=30000

# Or in test command:
PARSE_SERVER_TEST_TIMEOUT=30000 npm run testonly
```

### Out of memory errors
```bash
# Check container stats
docker stats parse-oracle-19c

# Increase Docker memory limit (Docker Desktop → Settings → Resources)
# Recommended: At least 4GB for Oracle

# Or use slimmer image
docker pull gvenzl/oracle-free:23-slim-faststart
```

### Permission errors
```bash
# Connect as SYSTEM to grant permissions
docker exec -it parse-oracle-19c sqlplus system/ParseTest123!@//localhost:1521/FREEPDB1

# Grant all privileges to parseserver
GRANT ALL PRIVILEGES TO parseserver;
```

### Clean up test data
```sql
-- Connect to database
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1

-- Drop all test tables
BEGIN
  FOR t IN (SELECT table_name FROM user_tables WHERE table_name LIKE 'test_%') LOOP
    EXECUTE IMMEDIATE 'DROP TABLE "' || t.table_name || '" CASCADE CONSTRAINTS';
  END LOOP;
END;
/

-- Verify
SELECT COUNT(*) FROM user_tables WHERE table_name LIKE 'test_%';
```

---

## Connection String Formats

### Standard Format
```
oracle://username:password@host:port/service_name
```

### Examples
```bash
# Local Docker
oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1

# With special characters in password (URL encode)
oracle://user:p%40ssw%3Drd@localhost:1521/FREEPDB1

# TNS Alias (if tnsnames.ora configured)
oracle://username:password@TNS_ALIAS

# External Authentication
oracle:///@localhost:1521/ORCL?externalAuth=true

# With custom pool options
oracle://user:pass@localhost:1521/ORCL?poolMin=1&poolMax=10&poolIncrement=2
```

---

## Performance Tips

### Use Slim Images
```bash
# Faster startup, smaller size
docker pull gvenzl/oracle-free:23-slim-faststart
```

### Persist Data with Volumes
```bash
# Create volume for data persistence
docker volume create oracle-data

# Run with volume
docker run -d \
  --name parse-oracle-19c \
  -p 1521:1521 \
  -e ORACLE_PASSWORD=ParseTest123! \
  -e APP_USER=parseserver \
  -e APP_USER_PASSWORD=ParseTest123! \
  -v oracle-data:/opt/oracle/oradata \
  gvenzl/oracle-free:23-slim
```

### Optimize Pool Settings
```javascript
// In your adapter configuration
const adapter = new OracleStorageAdapter({
  uri: 'oracle://parseserver:password@localhost:1521/FREEPDB1',
  databaseOptions: {
    poolMin: 2,
    poolMax: 10,
    poolIncrement: 2,
    poolTimeout: 60
  }
});
```

---

## CI/CD Integration

### GitHub Actions Example
```yaml
name: Test Oracle Adapter

on: [push, pull_request]

jobs:
  test-oracle:
    runs-on: ubuntu-latest
    
    services:
      oracle:
        image: gvenzl/oracle-free:23-slim
        env:
          ORACLE_PASSWORD: ParseTest123!
          APP_USER: parseserver
          APP_USER_PASSWORD: ParseTest123!
        ports:
          - 1521:1521
        options: >-
          --health-cmd "sqlplus -s parseserver/ParseTest123!@//localhost:1521/FREEPDB1 <<< 'SELECT 1 FROM dual;'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 30
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Test with Oracle
        env:
          PARSE_SERVER_TEST_DB: oracle
          PARSE_SERVER_TEST_DATABASE_URI: oracle://parseserver:ParseTest123!@localhost:1521/FREEPDB1
        run: npm run testonly
```

---

## Resources

- **Oracle Free Documentation:** https://www.oracle.com/database/free/
- **Docker Image (gvenzl):** https://github.com/gvenzl/oci-oracle-free
- **Oracle SQL Reference:** https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/
- **Parse Server Docs:** https://docs.parseplatform.org/

---

## Quick Reference Card

```bash
# Setup
./docker-oracle-setup.sh

# Test
source .env.oracle.test && npm run testonly

# Connect
docker exec -it parse-oracle-19c sqlplus parseserver/ParseTest123!@//localhost:1521/FREEPDB1

# Logs
docker logs -f parse-oracle-19c

# Stop/Start
docker stop parse-oracle-19c
docker start parse-oracle-19c

# Clean up
docker rm -f parse-oracle-19c
```

---

**Last Updated:** December 2024
**Tested With:** Oracle Free 23c, Parse Server 7.5.4

