-- Function to remove values from a JSON array
-- Equivalent to PostgreSQL's array_remove function
-- Note: VARCHAR2(32767) is the maximum size for PL/SQL VARCHAR2 in Oracle 12c+

CREATE OR REPLACE FUNCTION parse_array_remove(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
BEGIN
  -- Keep only elements that are NOT in the values to remove
  SELECT COALESCE(
    JSON_ARRAYAGG(jt.val RETURNING CLOB),
    '[]'
  ) INTO v_result
  FROM JSON_TABLE(COALESCE(p_array, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jt
  WHERE jt.val NOT IN (
    SELECT jr.val
    FROM JSON_TABLE(COALESCE(p_values, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jr
  );

  RETURN v_result;
END parse_array_remove;
/
