import dlt


@dlt.table
def bronze_customers():
    return spark.range(10)
