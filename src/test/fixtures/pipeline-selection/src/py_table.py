from pyspark import pipelines as dp

@dp.materialized_view
def t_py():
    return spark.range(3)
