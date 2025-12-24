-- Function to check if array contains all of the given values
-- Equivalent to PostgreSQL's array_contains_all function
-- Note: VARCHAR2(4000) is the standard SQL limit in Oracle

CREATE OR REPLACE FUNCTION parse_array_contains_all(
  p_array   IN CLOB,
  p_values  IN CLOB
) RETURN NUMBER
IS
  v_values_count NUMBER;
  v_match_count NUMBER;
  v_arr CLOB := COALESCE(p_array, '[]');
  v_vals CLOB := COALESCE(p_values, '[]');
BEGIN
  -- Get the count of values we're looking for
  SELECT COUNT(*) INTO v_values_count
  FROM JSON_TABLE(v_vals, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$'));

  -- If no values to check, return false (empty $all never matches)
  IF v_values_count = 0 THEN
    RETURN 0;
  END IF;

  -- Count how many of the required values exist in the array
  SELECT COUNT(DISTINCT jv.val) INTO v_match_count
  FROM JSON_TABLE(v_vals, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jv
  WHERE jv.val IN (
    SELECT jt.val
    FROM JSON_TABLE(v_arr, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
  );

  -- Return 1 (true) if all values found, 0 (false) otherwise
  IF v_match_count = v_values_count THEN
    RETURN 1;
  ELSE
    RETURN 0;
  END IF;
END parse_array_contains_all;
/
