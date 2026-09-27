from pyspark import pipelines as dp


@dp.table
def sample_trips():
    return spark.read.table("samples.nyctaxi.trips")
