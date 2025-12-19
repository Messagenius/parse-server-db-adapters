/**
 * Oracle Database Configuration Parser
 *
 * Parses oracle:// URIs and returns connection options for oracledb.
 *
 * Supports two connection formats:
 * 1. Standard: oracle://user:password@host:port/service_name
 * 2. Wallet-based (TNS): oracle://user:password@TNS_ALIAS
 *    - Uses environment variables: TNS_ADMIN, ORACLE_CLIENT_LOCATION, ORACLE_WALLET_LOCATION
 */

function getDatabaseOptionsFromURI(uri) {
  const databaseOptions = {};

  const parsedURI = new URL(uri);
  const queryParams = parseQueryParams(parsedURI.searchParams.toString());

  databaseOptions.user = parsedURI.username ? decodeURIComponent(parsedURI.username) : undefined;
  databaseOptions.password = parsedURI.password ? decodeURIComponent(parsedURI.password) : undefined;

  const hostname = parsedURI.hostname;
  const port = parsedURI.port;
  const pathname = parsedURI.pathname ? parsedURI.pathname.substring(1) : undefined;

  // Determine if this is a standard connection or TNS-based
  // TNS-based: no port and no pathname (service_name), hostname is the TNS alias
  // Standard: has port and/or pathname
  if (port || pathname) {
    // Standard connection string format
    // oracle://user:password@host:port/service_name
    const host = hostname || 'localhost';
    const portNum = port ? parseInt(port, 10) : 1521;
    const serviceName = pathname || 'FREEPDB1';

    // Build Easy Connect string for oracledb
    databaseOptions.connectString = `${host}:${portNum}/${serviceName}`;
  } else {
    // TNS alias format
    // oracle://user:password@TNS_ALIAS
    // The hostname IS the TNS alias
    databaseOptions.connectString = hostname;

    // TNS-based connections may use wallet authentication
    // Environment variables are read by oracledb automatically:
    // - TNS_ADMIN: location of tnsnames.ora and sqlnet.ora
    // - ORACLE_CLIENT_LOCATION or LD_LIBRARY_PATH: Oracle client location
    // - ORACLE_WALLET_LOCATION: wallet location (if not in TNS_ADMIN)
  }

  // Pool configuration
  if (queryParams.poolMin) {
    databaseOptions.poolMin = parseInt(queryParams.poolMin, 10) || 0;
  }
  if (queryParams.poolMax) {
    databaseOptions.poolMax = parseInt(queryParams.poolMax, 10) || 4;
  }
  if (queryParams.poolIncrement) {
    databaseOptions.poolIncrement = parseInt(queryParams.poolIncrement, 10) || 1;
  }
  if (queryParams.poolTimeout) {
    databaseOptions.poolTimeout = parseInt(queryParams.poolTimeout, 10) || 60;
  }
  if (queryParams.poolPingInterval) {
    databaseOptions.poolPingInterval = parseInt(queryParams.poolPingInterval, 10) || 60;
  }

  // Statement cache size
  if (queryParams.stmtCacheSize) {
    databaseOptions.stmtCacheSize = parseInt(queryParams.stmtCacheSize, 10) || 30;
  }

  // Connection timeout
  if (queryParams.connectTimeout) {
    databaseOptions.connectTimeout = parseInt(queryParams.connectTimeout, 10);
  }

  // External authentication (wallet without password)
  if (queryParams.externalAuth && queryParams.externalAuth.toLowerCase() === 'true') {
    databaseOptions.externalAuth = true;
    delete databaseOptions.user;
    delete databaseOptions.password;
  }

  return databaseOptions;
}

function parseQueryParams(queryString) {
  queryString = queryString || '';

  return queryString.split('&').reduce((p, c) => {
    if (!c) return p;
    const parts = c.split('=');
    p[decodeURIComponent(parts[0])] =
      parts.length > 1 ? decodeURIComponent(parts.slice(1).join('=')) : '';
    return p;
  }, {});
}

module.exports = {
  parseQueryParams: parseQueryParams,
  getDatabaseOptionsFromURI: getDatabaseOptionsFromURI,
};
