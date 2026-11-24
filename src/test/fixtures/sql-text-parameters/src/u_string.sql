-- unpassed, inside a string: the text should stay as written
SELECT assert_true('{{run_date}}' = concat('{', '{run_date', '}', '}')) AS ok
