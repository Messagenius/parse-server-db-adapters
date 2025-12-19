const OracleStorageAdapter = require('../lib/Adapters/Storage/Oracle/OracleStorageAdapter')
  .default;
const databaseURI =
  process.env.PARSE_SERVER_TEST_DATABASE_URI ||
  'oracle://system:oracle@localhost:1521/FREEPDB1';
const Config = require('../lib/Config');

const getColumns = async (adapter, className) => {
  const conn = await adapter._getConnection();
  try {
    const result = await conn.execute(
      `SELECT column_name FROM user_tab_columns WHERE table_name = :className`,
      { className }
    );
    return result.rows.map(row => row.COLUMN_NAME);
  } finally {
    await conn.close();
  }
};

const dropTable = async (adapter, className) => {
  const conn = await adapter._getConnection();
  try {
    await conn.execute(`DROP TABLE "${className}"`);
    await conn.commit();
  } catch (error) {
    // Ignore if table doesn't exist
  } finally {
    await conn.close();
  }
};

describe_only_db('oracle')('OracleStorageAdapter', () => {
  let adapter;
  beforeEach(async () => {
    const config = Config.get('test');
    adapter = config.database.adapter;
  });

  it('schemaUpgrade, upgrade the database schema when schema changes', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });
    const className = '_PushStatus';
    const schema = {
      fields: {
        pushTime: { type: 'String' },
        source: { type: 'String' },
        query: { type: 'String' },
      },
    };

    await adapter.createTable(className, schema);
    let columns = await getColumns(adapter, className);

    expect(columns).toContain('pushTime');
    expect(columns).toContain('source');
    expect(columns).toContain('query');
    expect(columns).not.toContain('expiration_interval');

    schema.fields.expiration_interval = { type: 'Number' };
    await adapter.schemaUpgrade(className, schema);

    columns = await getColumns(adapter, className);
    expect(columns).toContain('pushTime');
    expect(columns).toContain('source');
    expect(columns).toContain('query');
    expect(columns).toContain('expiration_interval');

    await reconfigureServer();
  });

  it('schemaUpgrade, maintain correct schema', async () => {
    const className = 'Table';
    const schema = {
      fields: {
        columnA: { type: 'String' },
        columnB: { type: 'String' },
        columnC: { type: 'String' },
      },
    };

    await adapter.createTable(className, schema);
    let columns = await getColumns(adapter, className);

    expect(columns).toContain('columnA');
    expect(columns).toContain('columnB');
    expect(columns).toContain('columnC');

    await adapter.schemaUpgrade(className, schema);
    columns = await getColumns(adapter, className);

    expect(columns.length).toEqual(3);
    expect(columns).toContain('columnA');
    expect(columns).toContain('columnB');
    expect(columns).toContain('columnC');
  });

  it('Create a table without columns and upgrade with columns', async () => {
    const className = 'EmptyTable';
    await dropTable(adapter, className);
    await adapter.createTable(className, {});

    let columns = await getColumns(adapter, className);
    expect(columns.length).toBe(0);

    const newSchema = {
      fields: {
        columnA: { type: 'String' },
        columnB: { type: 'String' },
      },
    };

    await adapter.schemaUpgrade(className, newSchema);
    columns = await getColumns(adapter, className);

    expect(columns.length).toEqual(2);
    expect(columns).toContain('columnA');
    expect(columns).toContain('columnB');
  });

  it('getClass if exists', async () => {
    const schema = {
      fields: {
        array: { type: 'Array' },
        object: { type: 'Object' },
        date: { type: 'Date' },
      },
    };
    await adapter.createClass('MyClass', schema);
    const myClassSchema = await adapter.getClass('MyClass');
    expect(myClassSchema).toBeDefined();
  });

  it('getClass if not exists', async () => {
    const schema = {
      fields: {
        array: { type: 'Array' },
        object: { type: 'Object' },
        date: { type: 'Date' },
      },
    };
    await adapter.createClass('MyClass', schema);
    await expectAsync(adapter.getClass('UnknownClass')).toBeRejectedWith(undefined);
  });

  it('should create and retrieve objects', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const obj = new Parse.Object('TestClass');
    obj.set('name', 'Test');
    obj.set('score', 100);
    obj.set('active', true);
    await obj.save();

    const query = new Parse.Query('TestClass');
    const result = await query.get(obj.id);

    expect(result.get('name')).toBe('Test');
    expect(result.get('score')).toBe(100);
    expect(result.get('active')).toBe(true);
  });

  it('should handle basic queries with comparisons', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    // Create test objects
    for (let i = 1; i <= 5; i++) {
      const obj = new Parse.Object('ScoreClass');
      obj.set('score', i * 10);
      await obj.save();
    }

    // Test $gt
    const gtQuery = new Parse.Query('ScoreClass');
    gtQuery.greaterThan('score', 30);
    const gtResults = await gtQuery.find();
    expect(gtResults.length).toBe(2);

    // Test $lt
    const ltQuery = new Parse.Query('ScoreClass');
    ltQuery.lessThan('score', 30);
    const ltResults = await ltQuery.find();
    expect(ltResults.length).toBe(2);

    // Test $gte
    const gteQuery = new Parse.Query('ScoreClass');
    gteQuery.greaterThanOrEqualTo('score', 30);
    const gteResults = await gteQuery.find();
    expect(gteResults.length).toBe(3);

    // Test $lte
    const lteQuery = new Parse.Query('ScoreClass');
    lteQuery.lessThanOrEqualTo('score', 30);
    const lteResults = await lteQuery.find();
    expect(lteResults.length).toBe(3);
  });

  it('should handle pagination with skip and limit', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    // Create 10 test objects
    for (let i = 1; i <= 10; i++) {
      const obj = new Parse.Object('PageClass');
      obj.set('index', i);
      await obj.save();
    }

    // Test limit
    const limitQuery = new Parse.Query('PageClass');
    limitQuery.limit(5);
    const limitResults = await limitQuery.find();
    expect(limitResults.length).toBe(5);

    // Test skip
    const skipQuery = new Parse.Query('PageClass');
    skipQuery.skip(5);
    const skipResults = await skipQuery.find();
    expect(skipResults.length).toBe(5);

    // Test skip and limit together
    const pageQuery = new Parse.Query('PageClass');
    pageQuery.skip(3);
    pageQuery.limit(3);
    const pageResults = await pageQuery.find();
    expect(pageResults.length).toBe(3);
  });

  it('should handle sorting', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    // Create test objects in random order
    const values = [5, 2, 8, 1, 9];
    for (const val of values) {
      const obj = new Parse.Object('SortClass');
      obj.set('value', val);
      await obj.save();
    }

    // Test ascending sort
    const ascQuery = new Parse.Query('SortClass');
    ascQuery.ascending('value');
    const ascResults = await ascQuery.find();
    expect(ascResults[0].get('value')).toBe(1);
    expect(ascResults[4].get('value')).toBe(9);

    // Test descending sort
    const descQuery = new Parse.Query('SortClass');
    descQuery.descending('value');
    const descResults = await descQuery.find();
    expect(descResults[0].get('value')).toBe(9);
    expect(descResults[4].get('value')).toBe(1);
  });

  it('should handle $in and $nin queries', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    // Create test objects
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    for (const name of names) {
      const obj = new Parse.Object('PersonClass');
      obj.set('name', name);
      await obj.save();
    }

    // Test $in
    const inQuery = new Parse.Query('PersonClass');
    inQuery.containedIn('name', ['Alice', 'Bob', 'Charlie']);
    const inResults = await inQuery.find();
    expect(inResults.length).toBe(3);

    // Test $nin
    const ninQuery = new Parse.Query('PersonClass');
    ninQuery.notContainedIn('name', ['Alice', 'Bob']);
    const ninResults = await ninQuery.find();
    expect(ninResults.length).toBe(3);
  });

  it('should handle count queries', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    // Create test objects
    for (let i = 0; i < 7; i++) {
      const obj = new Parse.Object('CountClass');
      obj.set('index', i);
      await obj.save();
    }

    const query = new Parse.Query('CountClass');
    const count = await query.count();
    expect(count).toBe(7);

    // Count with filter
    const filteredQuery = new Parse.Query('CountClass');
    filteredQuery.greaterThan('index', 3);
    const filteredCount = await filteredQuery.count();
    expect(filteredCount).toBe(3);
  });

  it('should handle update operations', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const obj = new Parse.Object('UpdateClass');
    obj.set('name', 'Original');
    obj.set('score', 100);
    await obj.save();

    obj.set('name', 'Updated');
    obj.increment('score', 50);
    await obj.save();

    const query = new Parse.Query('UpdateClass');
    const result = await query.get(obj.id);
    expect(result.get('name')).toBe('Updated');
    expect(result.get('score')).toBe(150);
  });

  it('should handle delete operations', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const obj = new Parse.Object('DeleteClass');
    obj.set('name', 'ToDelete');
    await obj.save();

    const id = obj.id;
    await obj.destroy();

    const query = new Parse.Query('DeleteClass');
    try {
      await query.get(id);
      fail('Should have thrown error');
    } catch (error) {
      expect(error.code).toBe(Parse.Error.OBJECT_NOT_FOUND);
    }
  });

  it('should handle boolean fields correctly', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const objTrue = new Parse.Object('BoolClass');
    objTrue.set('flag', true);
    await objTrue.save();

    const objFalse = new Parse.Object('BoolClass');
    objFalse.set('flag', false);
    await objFalse.save();

    const trueQuery = new Parse.Query('BoolClass');
    trueQuery.equalTo('flag', true);
    const trueResults = await trueQuery.find();
    expect(trueResults.length).toBe(1);
    expect(trueResults[0].get('flag')).toBe(true);

    const falseQuery = new Parse.Query('BoolClass');
    falseQuery.equalTo('flag', false);
    const falseResults = await falseQuery.find();
    expect(falseResults.length).toBe(1);
    expect(falseResults[0].get('flag')).toBe(false);
  });

  it('should handle Date fields correctly', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const now = new Date();
    const obj = new Parse.Object('DateClass');
    obj.set('eventDate', now);
    await obj.save();

    const query = new Parse.Query('DateClass');
    const result = await query.get(obj.id);
    const retrievedDate = result.get('eventDate');

    expect(retrievedDate instanceof Date).toBe(true);
    expect(retrievedDate.getTime()).toBe(now.getTime());
  });

  it('should handle Object and Array fields', async () => {
    await adapter.deleteAllClasses();
    const config = Config.get('test');
    config.schemaCache.clear();
    await adapter.performInitialization({ VolatileClassesSchemas: [] });

    const database = Config.get(Parse.applicationId).database;
    await database.loadSchema({ clearCache: true });

    const testObject = { key1: 'value1', key2: 123, nested: { a: 'b' } };
    const testArray = [1, 'two', { three: 3 }];

    const obj = new Parse.Object('ComplexClass');
    obj.set('data', testObject);
    obj.set('items', testArray);
    await obj.save();

    const query = new Parse.Query('ComplexClass');
    const result = await query.get(obj.id);

    expect(result.get('data')).toEqual(testObject);
    expect(result.get('items')).toEqual(testArray);
  });
});

describe_only_db('oracle')('OracleStorageAdapter shutdown', () => {
  it('handleShutdown, close connection pool', async () => {
    const adapter = new OracleStorageAdapter({ uri: databaseURI });
    await adapter._ensureConnection();
    expect(adapter._pool).toBeDefined();
    await adapter.handleShutdown();
    expect(adapter._pool).toBeNull();
  });

  it('handleShutdown, close connection pool of oracledb uri', async () => {
    const databaseURI2 = new URL(databaseURI);
    databaseURI2.protocol = 'oracledb:';
    const adapter = new OracleStorageAdapter({ uri: databaseURI2.toString() });
    await adapter._ensureConnection();
    expect(adapter._pool).toBeDefined();
    await adapter.handleShutdown();
    expect(adapter._pool).toBeNull();
  });
});
