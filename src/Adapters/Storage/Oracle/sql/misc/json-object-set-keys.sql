-- Function to set a key on a JSON object
-- Equivalent to PostgreSQL's json_object_set_key function

CREATE OR REPLACE FUNCTION parse_json_object_set_key(
  p_json        IN CLOB,
  p_key_to_set  IN VARCHAR2,
  p_value       IN CLOB
) RETURN CLOB
IS
  v_result CLOB;
BEGIN
  -- Use JSON_MERGEPATCH to set/update a key in the JSON object
  -- First, create a patch object with the key to set
  SELECT JSON_MERGEPATCH(
    COALESCE(p_json, '{}'),
    JSON_OBJECT(p_key_to_set VALUE JSON_QUERY(p_value, '$' WITH WRAPPER) RETURNING CLOB)
  ) INTO v_result
  FROM DUAL;

  RETURN v_result;
EXCEPTION
  WHEN OTHERS THEN
    -- If JSON_QUERY fails (for non-JSON values), try as scalar
    SELECT JSON_MERGEPATCH(
      COALESCE(p_json, '{}'),
      JSON_OBJECT(p_key_to_set VALUE p_value RETURNING CLOB)
    ) INTO v_result
    FROM DUAL;
    RETURN v_result;
END parse_json_object_set_key;
/
