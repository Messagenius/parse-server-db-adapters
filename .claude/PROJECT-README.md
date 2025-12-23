# SQL-Based Oracle Adapter Derived from PostgreSQL Adapter
This is the Parse Server repository.
Parse Server has storage adaptors for MongoDB and Postgres.
Postgres Adapter is in src/Adapters/Storage/Postgres

This project is to create **new Oracle storage adapter for Parse Server**, starting from the **existing PostgreSQL adapter**.

The goal is to progressively port the PostgreSQL adapter logic to **Oracle SQL**, while keeping the logic vey similar to the postgres approach.
You need to follow a **three-milestone plan** with **minimal, incremental changes**
The connection should accept an oracle:// string and either a standard connection string, or a wallet based connection.
In that case the library that is used will be use the environment variables such as ORACLE_CLIENT_LOCATION, ORACLE_WALLET_LOCATION, LD_LIBRARY_PATH, TNS_ADMIN


Each milestone must be suitable for a **separate merge request** and executed **one at a time**.

If limitations, missing features, or optimizations are identified:
- they must be **documented**, in a TODO-optimizations.md file, not implemented early
- optimizations are allowed **only in Milestone 3**

---

## Overall Context

- The PostgreSQL adapter:
  - maps Parse classes to SQL tables
  - maps Parse fields to SQL columns
  - translates Parse/Mongo-style queries into **native SQL**
- The new Oracle adapter must:
  - keep the **same logical query structure**
  - translate it into **Oracle-compatible SQL**
  - use **Oracle client and connection logic** from the existing Oracle adapter
- Target baseline is **Oracle Database 19c**, the most common enterprise version.

The adapter must remain **schema-aware** and **SQL-driven**, not document-driven.

---

## Milestone Summary (High-Level)

### Milestone 1 — Baseline SQL Compatibility  
Make the adapter **run on Oracle 19c** with basic CRUD and simple queries, accepting limitations on some unsupported column types or query types or indexes, and documenting them.

### Milestone 2 — Query Feature Coverage  
Incrementally support additional Parse operators and query patterns using Oracle SQL.

### Milestone 3 — Optimizations  
Improve performance, indexing strategy, and query efficiency while preserving behavior.

Following, a detailed plan for each milestone.
AI: Proceed only once you have received the detailed milestone plan below. Ask question on each step when necessary. Identify planning mistakes if any.

---

## Milestone 1 — Baseline Oracle SQL Compatibility

### Goal
Create a **minimal working Oracle SQL adapter** derived from the PostgreSQL adapter that:
- connects successfully
- creates tables
- supports standard data types (text, numbers, etc)
- supports basic CRUD
- executes simple `WHERE`, `ORDER BY`, `LIMIT`-like queries

Functional compromises are acceptable.

### Tasks
1. Reuse the **PostgreSQL adapter’s schema model** (table-per-class, column-per-field).
2. Replace PostgreSQL-specific SQL syntax with **Oracle 19c-compatible SQL**, including:
   - identifiers
   - data types
   - basic WHERE clauses
3. Implement **Oracle-compatible pagination** for basic cases.
4. Use the **Oracle adapter’s connection, pooling, and authentication logic** (wallet, client setup).
5. Ensure Parse can:
   - start successfully
   - create system tables
   - perform basic create, read, update, delete
6. Create or update a Markdown documentation file listing:
   - unsupported Parse features
   - known SQL limitations
   - explicit non-goals of Milestone 1  
   (e.g. “Geo queries are not supported”, “Complex array operators not supported”.)

### DO NOT (Milestone 1)
- ❌ Do not attempt full operator parity with PostgreSQL
- ❌ Do not optimize queries
- ❌ Do not refactor the adapter architecture
- ❌ Do not introduce document-store or SODA-based querying
- ❌ Do not introduce Oracle-specific advanced features
- ❌ Do not silently change Parse semantics

### Deliverables
- Minimal Oracle SQL adapter implementation
- Documentation of known incompatibilities

---

## Milestone 2 — SQL Query Feature Coverage

### Goal
Extend the Oracle SQL adapter to support **additional Parse query operators** that are feasible on Oracle 19c.

### Tasks
1. Review limitations documented in Milestone 1.
2. Incrementally implement support for additional operators, such as:
   - `containedIn`
   - `notEqualTo`
   - basic `OR` / `AND`
   - simple array-like patterns where feasible
3. Adapt PostgreSQL-specific constructs to **Oracle SQL equivalents**, documenting differences.
4. Update documentation to reflect:
   - newly supported features
   - remaining gaps

### DO NOT (Milestone 2)
- ❌ Do not introduce performance tuning
- ❌ Do not change table or column mapping strategy
- ❌ Do not add Oracle-specific optimizations
- ❌ Do not break backward compatibility
- ❌ Do not assume Oracle versions newer than 19c

### Deliverables
- Incremental feature support
- Updated documentation

---

## Milestone 3 — Performance and SQL Optimizations

### Goal
Improve performance and robustness **without changing external behavior**.

### Tasks
1. Identify performance bottlenecks, including:
   - pagination strategy
   - count queries
   - index usage
2. Apply safe optimizations such as:
   - improved pagination patterns
   - index recommendations
   - query simplification
3. If deeper architectural changes are identified:
   - document them clearly
   - do not implement unless explicitly requested

### DO NOT (Milestone 3)
- ❌ Do not change Parse query semantics
- ❌ Do not remove backward compatibility
- ❌ Do not introduce breaking schema changes
- ❌ Do not introduce version-specific SQL unless documented

### Deliverables
- Optional optimizations
- Performance notes and design considerations in documentation

---

## Output Requirements

For each milestone:
- Provide **exact code changes** (diffs or edited snippets).
- Clearly state:
  - what was implemented
  - what remains unsupported
- Update documentation as required.

Assume milestones are executed **sequentially**, each as a **separate merge request**.

