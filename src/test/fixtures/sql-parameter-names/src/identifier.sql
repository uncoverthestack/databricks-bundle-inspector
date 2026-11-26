USE CATALOG {{cat}};
USE IDENTIFIER({{schema}});
SELECT 1 FROM IDENTIFIER({{cat}} || '.' || {{schema}} || '.catalogs');
