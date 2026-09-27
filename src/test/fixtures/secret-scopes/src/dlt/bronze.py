import dlt
key = dbutils.secrets.get(scope="pipeline-scope", key="source_key")
@dlt.table
def bronze():
    return spark.range(1)
