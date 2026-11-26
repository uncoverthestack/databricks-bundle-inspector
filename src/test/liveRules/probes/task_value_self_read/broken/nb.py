# Databricks notebook source
print(dbutils.jobs.taskValues.get(taskKey="selfread", key="never_set"))
