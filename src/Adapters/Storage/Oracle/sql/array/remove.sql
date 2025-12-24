-- Function to remove values from a JSON array
-- Equivalent to PostgreSQL's array_remove function
-- Note: VARCHAR2(4000) is the standard SQL limit in Oracle

CREATE OR REPLACE FUNCTION parse_array_remove(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
  v_arr CLOB := COALESCE(p_array, '[]');
  v_vals CLOB := COALESCE(p_values, '[]');
BEGIN
  -- Keep only elements that are NOT in the values to remove
  SELECT COALESCE(
    JSON_ARRAYAGG(jt.val RETURNING VARCHAR2(4000)),
    '[]'
  ) INTO v_result
  FROM JSON_TABLE(v_arr, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
  WHERE jt.val NOT IN (
    SELECT jr.val
    FROM JSON_TABLE(v_vals, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jr
  );

  RETURN v_result;
END parse_array_remove;
/
