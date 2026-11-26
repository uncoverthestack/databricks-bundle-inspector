# Databricks notebook source
v = dbutils.jobs.taskValues.get(taskKey="selfread", key="never_set", default=0)
