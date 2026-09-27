import dlt


@dlt.table
def bronze_events():
    return spark.range(3)
