# Databricks notebook source
name = "dyn_" + "key"
dbutils.jobs.taskValues.set(key=name, value=1)
