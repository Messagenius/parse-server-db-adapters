'use strict';

const fs = require('fs');
const path = require('path');

// Cache for loaded SQL files
const sqlCache = {};

/**
 * Load a SQL file and cache it
 * @param {string} file - Relative path to SQL file
 * @returns {string} SQL content
 */
function loadSql(file) {
  if (sqlCache[file]) {
    return sqlCache[file];
  }

  const fullPath = path.join(__dirname, file);
  let content = fs.readFileSync(fullPath, 'utf8');
  // Remove trailing '/' which is used by sqlplus but causes errors with oracledb driver
  content = content.trim().replace(/\/\s*$/, '').trim();
  sqlCache[file] = content;
  return content;
}

/**
 * SQL files for Oracle stored functions
 * These functions should be created in the database during initialization
 */
module.exports = {
  array: {
    add: () => loadSql('array/add.sql'),
    addUnique: () => loadSql('array/add-unique.sql'),
    contains: () => loadSql('array/contains.sql'),
    containsAll: () => loadSql('array/contains-all.sql'),
    containsAllRegex: () => loadSql('array/contains-all-regex.sql'),
    remove: () => loadSql('array/remove.sql'),
  },
  misc: {
    jsonObjectSetKeys: () => loadSql('misc/json-object-set-keys.sql'),
  },

  /**
   * Get all SQL statements for creating stored functions
   * @returns {string[]} Array of SQL statements
   */
  getAllFunctionDefinitions: function () {
    return [
      this.array.add(),
      this.array.addUnique(),
      this.array.contains(),
      this.array.containsAll(),
      this.array.containsAllRegex(),
      this.array.remove(),
      this.misc.jsonObjectSetKeys(),
    ];
  },
};
