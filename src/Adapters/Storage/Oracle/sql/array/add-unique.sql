-- Function to add unique values to a JSON array
-- Equivalent to PostgreSQL's array_add_unique function
-- Note: VARCHAR2(32767) is the maximum size for PL/SQL VARCHAR2 in Oracle 12c+

CREATE OR REPLACE FUNCTION parse_array_add_unique(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
BEGIN
  -- Combine existing array with new values using UNION (removes duplicates)
  SELECT COALESCE(
    JSON_ARRAYAGG(val RETURNING CLOB),
    '[]'
  ) INTO v_result
  FROM (
    SELECT jt.val
    FROM JSON_TABLE(COALESCE(p_array, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jt
    UNION
    SELECT jn.val
    FROM JSON_TABLE(COALESCE(p_values, '[]'), '$[*]' COLUMNS (val VARCHAR2(32767) PATH '$')) jn
  );

  RETURN v_result;
END parse_array_add_unique;
/
