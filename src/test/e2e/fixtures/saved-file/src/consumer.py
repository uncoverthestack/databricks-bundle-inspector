# Databricks notebook source
rows = dbutils.jobs.taskValues.get(taskKey="producer", key="rowcount")
