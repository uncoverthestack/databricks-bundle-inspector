# Databricks notebook source


# widgets with no variable
dbutils.widgets.get('table_name')

# widgets with output stored in a function + multiline
target_table_name = dbutils.widgets.get(
    'target_table_name'
)

# COMMAND ----------

# widgets with space in a function

filter_str = dbutils.widgets.get(
    'filter_str'

)

# COMMAND ----------

# commented out widget
# filter_str = dbutils.widgets.get(
#     'filter_str'

# )

# susbtitution widget
table_name_2 = f"{dbutils.widgets.get('sub_table_name')}"

# MAGIC &sql
# COMMAND ----------
SELECT * FROM 1;
