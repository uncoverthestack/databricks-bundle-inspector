SELECT 1 FROM system.information_schema.schemata WHERE catalog_name IN (SELECT catalog_name FROM {{table}});
