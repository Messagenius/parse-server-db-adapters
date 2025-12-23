/**
 * Oracle Database Client
 *
 * Creates and manages Oracle database connection pools using oracledb.
 */

const parser = require('./OracleConfigParser');

let oracledb;

export async function createClient(uri, databaseOptions) {
  // Lazy load oracledb to allow the adapter to be loaded without the dependency
  if (!oracledb) {
    oracledb = require('oracledb');
  }

  let dbOptions = {};
  databaseOptions = databaseOptions || {};

  if (uri) {
    dbOptions = parser.getDatabaseOptionsFromURI(uri);
  }

  // Merge provided options (they take precedence)
  for (const key in databaseOptions) {
    dbOptions[key] = databaseOptions[key];
  }

  // Set default pool configuration if not specified
  // Use a unique pool alias to avoid conflicts when multiple adapters are created
  const defaultPoolAlias = `parseServer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const poolConfig = {
    user: dbOptions.user,
    password: dbOptions.password,
    connectString: dbOptions.connectString,
    poolMin: dbOptions.poolMin || 0,
    poolMax: dbOptions.poolMax || 4,
    poolIncrement: dbOptions.poolIncrement || 1,
    poolTimeout: dbOptions.poolTimeout || 60,
    poolPingInterval: dbOptions.poolPingInterval || 60,
    stmtCacheSize: dbOptions.stmtCacheSize || 30,
    poolAlias: dbOptions.poolAlias || defaultPoolAlias,
  };

  // Handle external authentication (wallet without user/password)
  if (dbOptions.externalAuth) {
    poolConfig.externalAuth = true;
    delete poolConfig.user;
    delete poolConfig.password;
  }

  // Add connect timeout if specified
  if (dbOptions.connectTimeout) {
    poolConfig.connectTimeout = dbOptions.connectTimeout;
  }

  // Configure oracledb settings
  // Use OBJECT mode to get results as objects with column names as keys
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

  // Auto-commit is off by default; we handle transactions manually
  oracledb.autoCommit = false;

  // Fetch CLOBs as strings
  oracledb.fetchAsString = [oracledb.CLOB];

  // Enable debug logging if requested
  if (process.env.PARSE_SERVER_LOG_LEVEL === 'debug') {
    // oracledb doesn't have a built-in debug mode like pg-monitor
    // Debugging can be done via Oracle's network tracing instead
    console.log('Oracle adapter: Debug mode enabled');
  }

  try {
    // Create the connection pool
    const pool = await oracledb.createPool(poolConfig);

    return {
      pool,
      oracledb,
      poolAlias: poolConfig.poolAlias,
    };
  } catch (error) {
    console.error('Failed to create Oracle connection pool:', error);
    throw error;
  }
}

export function getOracledb() {
  if (!oracledb) {
    oracledb = require('oracledb');
  }
  return oracledb;
}
