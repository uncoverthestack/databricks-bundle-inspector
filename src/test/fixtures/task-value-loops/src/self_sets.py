# Databricks notebook source
dbutils.jobs.taskValues.set(key="mine", value=1)
v = dbutils.jobs.taskValues.get(taskKey="selfread", key="mine")
