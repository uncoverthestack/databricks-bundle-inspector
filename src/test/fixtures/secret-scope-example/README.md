# default_python fixture

Synthetic test fixture for the databricks-bundle-inspector test suite.

`src/notebook.ipynb` contains three `dbutils.secrets.get` calls against the
`azure-key-vault` scope, used to verify secret detection across notebook cells.
