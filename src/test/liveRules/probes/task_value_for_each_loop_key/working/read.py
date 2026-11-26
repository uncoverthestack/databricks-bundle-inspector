# Databricks notebook source
print(dbutils.jobs.taskValues.get(taskKey="inner", key="result"))
