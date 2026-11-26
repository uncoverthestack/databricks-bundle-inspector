# Databricks notebook source
v = dbutils.jobs.taskValues.get(taskKey="loop", key="result", default=0)
