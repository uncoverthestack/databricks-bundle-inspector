# Databricks notebook source
ok = dbutils.jobs.taskValues.get(taskKey="producer", key="row_count", debugValue=0)
typo_key = dbutils.jobs.taskValues.get(taskKey="producer", key="rowcount", debugValue=0)
