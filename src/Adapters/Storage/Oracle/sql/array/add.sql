-- Function to append values to a JSON array
-- Equivalent to PostgreSQL's array_add function

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
    FROM JSON_TABLE(COALESCE(p_array, '[]'), '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
    UNION ALL
    SELECT jn.val
    FROM JSON_TABLE(COALESCE(p_values, '[]'), '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jn
  );

  RETURN v_result;
END parse_array_add;
/
