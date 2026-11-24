-- unpassed, in a WHERE clause on a string column
SELECT count(*) AS n FROM (SELECT '2026-11-24' AS d) WHERE d = '{{run_date}}'
