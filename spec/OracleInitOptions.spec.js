const Parse = require('parse/node').Parse;
const OracleStorageAdapter = require('../lib/Adapters/Storage/Oracle/OracleStorageAdapter')
  .default;
const oracleURI =
  process.env.PARSE_SERVER_TEST_DATABASE_URI ||
  'oracle://system:oracle@localhost:1521/FREEPDB1';

const GameScore = Parse.Object.extend({
  className: 'GameScore',
});

describe_only_db('oracle')('Oracle database init options', () => {
  it('should create server with default databaseOptions', async () => {
    const adapter = new OracleStorageAdapter({
      uri: oracleURI,
      collectionPrefix: 'test_',
      databaseOptions: {},
    });
    await reconfigureServer({
      databaseAdapter: adapter,
    });
    const score = new GameScore({
      score: 1337,
      playerName: 'Sean Plott',
      cheatMode: false,
    });
    await score.save();
  });

  it('should create server using oracledb uri', async () => {
    const oracledbURI = new URL(oracleURI);
    oracledbURI.protocol = 'oracledb:';
    const adapter = new OracleStorageAdapter({
      uri: oracledbURI.toString(),
      collectionPrefix: 'test_',
      databaseOptions: {},
    });
    await reconfigureServer({
      databaseAdapter: adapter,
    });
    const score = new GameScore({
      score: 1337,
      playerName: 'Sean Plott',
      cheatMode: false,
    });
    await score.save();
  });

  it('should create server with custom pool options', async () => {
    const adapter = new OracleStorageAdapter({
      uri: oracleURI,
      collectionPrefix: 'test_',
      databaseOptions: {
        poolMin: 1,
        poolMax: 5,
        poolIncrement: 1,
      },
    });
    await reconfigureServer({
      databaseAdapter: adapter,
    });
    const score = new GameScore({
      score: 1337,
      playerName: 'Sean Plott',
      cheatMode: false,
    });
    await score.save();
  });

  it('should handle schema cache TTL option', async () => {
    const adapter = new OracleStorageAdapter({
      uri: oracleURI,
      collectionPrefix: 'test_',
      databaseOptions: {
        schemaCacheTtl: 5000,
      },
    });
    expect(adapter.schemaCacheTtl).toBe(5000);
  });

  it('should handle enableSchemaHooks option', async () => {
    const adapter = new OracleStorageAdapter({
      uri: oracleURI,
      collectionPrefix: 'test_',
      databaseOptions: {
        enableSchemaHooks: true,
      },
    });
    expect(adapter.enableSchemaHooks).toBe(true);
  });
});
