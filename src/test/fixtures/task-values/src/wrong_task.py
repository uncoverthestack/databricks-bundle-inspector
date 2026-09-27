# Databricks notebook source
x = dbutils.jobs.taskValues.get(taskKey="prodcer", key="row_count", debugValue=0)
