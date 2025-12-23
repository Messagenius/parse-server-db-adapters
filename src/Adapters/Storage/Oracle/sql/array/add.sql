-- Function to append values to a JSON array
-- Equivalent to PostgreSQL's array_add function
-- Note: VARCHAR2(32767) is the maximum size for PL/SQL VARCHAR2 in Oracle 12c+
-- Array elements larger than this will be truncated

CREATE OR REPLACE FUNCTION parse_array_add(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
BEGIN
  -- Combine existing array with new values using UNION ALL (allows duplicates)
  SELECT COALESCE(
    JSON_ARRAYAGG(val RETURNING CLOB),
    '[]'
  ) INTO v_result
  FROM (
    SELECT jt.val
    FROM JSON_TABLE(COALESCE(p_array, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jt
    UNION ALL
    SELECT jn.val
    FROM JSON_TABLE(COALESCE(p_values, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jn
  );

  RETURN v_result;
END parse_array_add;
/
