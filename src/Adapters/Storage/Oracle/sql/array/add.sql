-- Function to append values to a JSON array
-- Equivalent to PostgreSQL's array_add function
-- Note: VARCHAR2(4000) is the standard SQL limit in Oracle

CREATE OR REPLACE FUNCTION parse_array_add(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
  v_arr CLOB := COALESCE(p_array, '[]');
  v_vals CLOB := COALESCE(p_values, '[]');
BEGIN
  -- Combine existing array with new values using UNION ALL (allows duplicates)
  SELECT COALESCE(
    JSON_ARRAYAGG(val RETURNING VARCHAR2(4000)),
    '[]'
  ) INTO v_result
  FROM (
    SELECT jt.val
    FROM JSON_TABLE(v_arr, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
    UNION ALL
    SELECT jn.val
    FROM JSON_TABLE(v_vals, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jn
  );

  RETURN v_result;
END parse_array_add;
/
