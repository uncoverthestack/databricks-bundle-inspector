# Databricks notebook source
keyword = dbutils.jobs.taskValues.get(taskKey="producer", key="optional_keyword", default="fallback")
positional = dbutils.jobs.taskValues.get("producer", "optional_positional", "fallback")
none_default = dbutils.jobs.taskValues.get(taskKey="producer", key="none_default", default=None)
debug_only = dbutils.jobs.taskValues.get(taskKey="producer", key="debug_only", debugValue="x")
with_default = dbutils.jobs.taskValues.get(taskKey="producer", key="read_twice", default="x")
without_default = dbutils.jobs.taskValues.get(taskKey="producer", key="read_twice")
from_variable = dbutils.jobs.taskValues.get(taskKey="producer", key="variable_default", default=fallback)
