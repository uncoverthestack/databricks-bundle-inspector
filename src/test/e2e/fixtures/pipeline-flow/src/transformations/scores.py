from pyspark import pipelines as dp


@dp.table
def order_scores():
    return spark.read.table("orders_silver")
