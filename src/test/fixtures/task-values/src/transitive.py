# Databricks notebook source
x = dbutils.jobs.taskValues.get(taskKey="producer", key="run_id", debugValue="")
y = dbutils.jobs.taskValues.get(taskKey="py_producer", key="py_key", debugValue=0)
z = dbutils.jobs.taskValues.get(taskKey="dynamic_producer", key="anything", debugValue=0)
