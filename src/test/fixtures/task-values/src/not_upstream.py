# Databricks notebook source
x = dbutils.jobs.taskValues.get(taskKey="producer", key="run_id", debugValue="")
