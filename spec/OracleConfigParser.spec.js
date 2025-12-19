const parser = require('../lib/Adapters/Storage/Oracle/OracleConfigParser');

const queryParamTests = {
  'a=1&b=2': { a: '1', b: '2' },
  'a=abcd%20efgh&b=abcd%3Defgh': { a: 'abcd efgh', b: 'abcd=efgh' },
  'a=1&b&c=true': { a: '1', b: '', c: 'true' },
};

describe('OracleConfigParser.parseQueryParams', () => {
  it('creates a map from a query string', () => {
    for (const key in queryParamTests) {
      const result = parser.parseQueryParams(key);

      const testObj = queryParamTests[key];

      expect(Object.keys(result).length).toEqual(Object.keys(testObj).length);

      for (const k in result) {
        expect(result[k]).toEqual(testObj[k]);
      }
    }
  });
});

const standardURI = 'oracle://username:password@localhost:1521/FREEPDB1';
const tnsURI = 'oracle://username:password@TNS_ALIAS';

const dbOptionsTest = {};

// Standard connection tests
dbOptionsTest[`${standardURI}?poolMin=2&poolMax=10&poolIncrement=2`] = {
  user: 'username',
  password: 'password',
  connectString: 'localhost:1521/FREEPDB1',
  poolMin: 2,
  poolMax: 10,
  poolIncrement: 2,
};

dbOptionsTest[`${standardURI}?poolTimeout=120&stmtCacheSize=50`] = {
  user: 'username',
  password: 'password',
  connectString: 'localhost:1521/FREEPDB1',
  poolTimeout: 120,
  stmtCacheSize: 50,
};

dbOptionsTest[`${standardURI}?poolPingInterval=30&connectTimeout=5000`] = {
  user: 'username',
  password: 'password',
  connectString: 'localhost:1521/FREEPDB1',
  poolPingInterval: 30,
  connectTimeout: 5000,
};

// TNS alias connection tests
dbOptionsTest[`${tnsURI}?poolMax=20`] = {
  user: 'username',
  password: 'password',
  connectString: 'TNS_ALIAS',
  poolMax: 20,
};

// External authentication test
dbOptionsTest[`oracle://user:pass@localhost:1521/ORCL?externalAuth=true`] = {
  connectString: 'localhost:1521/ORCL',
  externalAuth: true,
};

describe('OracleConfigParser.getDatabaseOptionsFromURI', () => {
  it('creates a db options map from a query string', () => {
    for (const key in dbOptionsTest) {
      const result = parser.getDatabaseOptionsFromURI(key);
      const testObj = dbOptionsTest[key];

      for (const k in testObj) {
        expect(result[k]).toEqual(testObj[k]);
      }
    }
  });

  it('parses standard connection string correctly', () => {
    const result = parser.getDatabaseOptionsFromURI(standardURI);

    expect(result.user).toEqual('username');
    expect(result.password).toEqual('password');
    expect(result.connectString).toEqual('localhost:1521/FREEPDB1');
  });

  it('parses TNS alias connection string correctly', () => {
    const result = parser.getDatabaseOptionsFromURI(tnsURI);

    expect(result.user).toEqual('username');
    expect(result.password).toEqual('password');
    expect(result.connectString).toEqual('TNS_ALIAS');
  });

  it('uses default port 1521 when not specified', () => {
    const result = parser.getDatabaseOptionsFromURI('oracle://user:pass@localhost/FREEPDB1');

    expect(result.connectString).toEqual('localhost:1521/FREEPDB1');
  });

  it('handles URL encoded username and password', () => {
    const result = parser.getDatabaseOptionsFromURI(
      'oracle://user%40domain:p%40ss%3Dword@localhost:1521/FREEPDB1'
    );

    expect(result.user).toEqual('user@domain');
    expect(result.password).toEqual('p@ss=word');
  });

  it('removes user/password when externalAuth is true', () => {
    const result = parser.getDatabaseOptionsFromURI(
      'oracle://user:pass@localhost:1521/ORCL?externalAuth=true'
    );

    expect(result.user).toBeUndefined();
    expect(result.password).toBeUndefined();
    expect(result.externalAuth).toBe(true);
  });

  it('sets poolMin to 0 if not a number', () => {
    const result = parser.getDatabaseOptionsFromURI(`${standardURI}?poolMin=abc`);

    expect(result.poolMin).toEqual(0);
  });

  it('sets poolMax to 4 if not a number', () => {
    const result = parser.getDatabaseOptionsFromURI(`${standardURI}?poolMax=abc`);

    expect(result.poolMax).toEqual(4);
  });
});
