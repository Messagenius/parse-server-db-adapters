-- Function to check if array contains all values matching regex patterns
-- Equivalent to PostgreSQL's array_contains_all_regex function
-- Note: VARCHAR2(4000) is the standard SQL limit in Oracle

CREATE OR REPLACE FUNCTION parse_array_contains_all_regex(
  p_array    IN CLOB,
  p_patterns IN CLOB
) RETURN NUMBER
IS
  v_patterns_count NUMBER;
  v_match_count NUMBER;
  v_arr CLOB := COALESCE(p_array, '[]');
  v_pats CLOB := COALESCE(p_patterns, '[]');
BEGIN
  -- Get the count of patterns we're looking for
  SELECT COUNT(*) INTO v_patterns_count
  FROM JSON_TABLE(v_pats, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$'));

  -- If no patterns to check, return false
  IF v_patterns_count = 0 THEN
    RETURN 0;
  END IF;

  -- Count how many patterns have at least one match in the array
  SELECT COUNT(DISTINCT jp.val) INTO v_match_count
  FROM JSON_TABLE(v_pats, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jp
  WHERE EXISTS (
    SELECT 1
    FROM JSON_TABLE(v_arr, '$[*]' COLUMNS (val VARCHAR2(4000) PATH '$')) jt
    WHERE REGEXP_LIKE(jt.val, jp.val)
  );

  -- Return 1 (true) if all patterns matched, 0 (false) otherwise
  IF v_match_count = v_patterns_count THEN
    RETURN 1;
  ELSE
    RETURN 0;
  END IF;
END parse_array_contains_all_regex;
/
