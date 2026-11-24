-- passed, but only part of the string: not the tested shape
SELECT * FROM t WHERE name LIKE '%{{run_date}}%'
