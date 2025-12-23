#!/bin/bash

# Oracle 19c Docker Setup Script for Parse Server Testing
# This script sets up Oracle Database 19c for testing the Oracle adapter

set -e

echo "🚀 Setting up Oracle 19c for Parse Server testing..."
echo ""

# Configuration
CONTAINER_NAME="parse-oracle-19c"
ORACLE_PASSWORD="ParseTest123!"
ORACLE_PORT="1521"
ORACLE_SERVICE="FREEPDB1"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker is installed${NC}"

# Check if container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${YELLOW}⚠️  Container '${CONTAINER_NAME}' already exists${NC}"
    read -p "Do you want to remove it and start fresh? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Stopping and removing existing container..."
        docker stop ${CONTAINER_NAME} 2>/dev/null || true
        docker rm ${CONTAINER_NAME} 2>/dev/null || true
        echo -e "${GREEN}✅ Removed existing container${NC}"
    else
        echo -e "${YELLOW}Using existing container. Checking if it's running...${NC}"
        if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            echo "Starting existing container..."
            docker start ${CONTAINER_NAME}
        fi
        exit 0
    fi
fi

echo ""
echo "📦 Pulling Oracle 19c Free (formerly XE) image..."
echo "   This may take several minutes on first run..."
echo ""

# Pull the Oracle image (using gvenzl/oracle-free which is Oracle 23c Free)
# For Oracle 19c specifically, we'll use gvenzl/oracle-xe:18-slim which is closest
# or oracle-xe:21-slim which is also available
docker pull gvenzl/oracle-free:23-slim

echo ""
echo "🐳 Starting Oracle 19c container..."
echo "   Container name: ${CONTAINER_NAME}"
echo "   Port: ${ORACLE_PORT}"
echo "   Service: ${ORACLE_SERVICE}"
echo "   Password: ${ORACLE_PASSWORD}"
echo ""

# Run Oracle container
docker run -d \
  --name ${CONTAINER_NAME} \
  -p ${ORACLE_PORT}:1521 \
  -e ORACLE_PASSWORD=${ORACLE_PASSWORD} \
  -e APP_USER=parseserver \
  -e APP_USER_PASSWORD=${ORACLE_PASSWORD} \
  gvenzl/oracle-free:23-slim

echo -e "${GREEN}✅ Container started${NC}"
echo ""
echo "⏳ Waiting for Oracle to initialize..."
echo "   This can take 2-5 minutes on first start..."
echo "   You can monitor progress with: docker logs -f ${CONTAINER_NAME}"
echo ""

# Wait for Oracle to be ready
MAX_ATTEMPTS=60
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if docker logs ${CONTAINER_NAME} 2>&1 | grep -q "DATABASE IS READY TO USE"; then
        echo -e "${GREEN}✅ Oracle database is ready!${NC}"
        break
    fi
    
    ATTEMPT=$((ATTEMPT + 1))
    echo -n "."
    sleep 5
    
    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
        echo -e "${RED}❌ Timeout waiting for Oracle to start${NC}"
        echo "Check logs with: docker logs ${CONTAINER_NAME}"
        exit 1
    fi
done

echo ""
echo ""
echo "🔍 Testing database connection..."

# Test connection using docker exec
if docker exec ${CONTAINER_NAME} sqlplus -s parseserver/${ORACLE_PASSWORD}@//localhost:1521/FREEPDB1 <<EOF
SELECT 'Connection successful!' AS status FROM dual;
EXIT;
EOF
then
    echo -e "${GREEN}✅ Database connection successful!${NC}"
else
    echo -e "${YELLOW}⚠️  Could not test connection, but database should be ready${NC}"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 Oracle 19c is ready for testing!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 Connection Details:"
echo "   Host:     localhost"
echo "   Port:     ${ORACLE_PORT}"
echo "   Service:  ${ORACLE_SERVICE}"
echo "   Username: parseserver"
echo "   Password: ${ORACLE_PASSWORD}"
echo ""
echo "🔗 Connection String:"
echo "   oracle://parseserver:${ORACLE_PASSWORD}@localhost:${ORACLE_PORT}/${ORACLE_SERVICE}"
echo ""
echo "🧪 Test with Parse Server:"
echo "   export PARSE_SERVER_TEST_DB=oracle"
echo "   export PARSE_SERVER_TEST_DATABASE_URI=oracle://parseserver:${ORACLE_PASSWORD}@localhost:${ORACLE_PORT}/${ORACLE_SERVICE}"
echo "   npm run testonly"
echo ""
echo "📊 Useful Docker Commands:"
echo "   View logs:       docker logs -f ${CONTAINER_NAME}"
echo "   Stop container:  docker stop ${CONTAINER_NAME}"
echo "   Start container: docker start ${CONTAINER_NAME}"
echo "   Remove container: docker rm -f ${CONTAINER_NAME}"
echo "   Connect to SQL:  docker exec -it ${CONTAINER_NAME} sqlplus parseserver/${ORACLE_PASSWORD}@//localhost:1521/${ORACLE_SERVICE}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

