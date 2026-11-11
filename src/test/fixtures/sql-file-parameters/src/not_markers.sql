-- WHERE region = :region
/* LIMIT :limit_rows */
SELECT 1::int AS one, '12:30' AS at_time, ':catalog' AS quoted,
       parse_json('{"owner": "a"}'):owner AS owner,
       '${legacy_name}' AS legacy;
