# Databricks notebook source
print(dbutils.jobs.taskValues.get(taskKey="loop", key="result"))
