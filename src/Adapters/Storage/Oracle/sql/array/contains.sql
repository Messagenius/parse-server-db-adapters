-- Function to check if array contains any of the given values
-- Equivalent to PostgreSQL's array_contains function
-- Note: VARCHAR2(4000) is the standard SQL limit in Oracle

CREATE OR REPLACE FUNCTION parse_array_contains(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN NUMBER
IS
  v_count NUMBER;
  v_array CLOB := COALESCE(p_array, '[]');
  v_vals  CLOB := COALESCE(p_values, '[]');
BEGIN
  -- Count how many elements from p_array are in p_values
  SELECT COUNT(*) INTO v_count
  FROM JSON_TABLE(v_array, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
  WHERE jt.val IN (
    SELECT jv.val
    FROM JSON_TABLE(v_vals, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jv
  );

  -- Return 1 (true) if at least one match, 0 (false) otherwise
  IF v_count >= 1 THEN
    RETURN 1;
  ELSE
    RETURN 0;
  END IF;
END parse_array_contains;
/
