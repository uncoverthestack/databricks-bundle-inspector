# Databricks notebook source
token = dbutils.secrets.get(scope="app-secrets", key="api_token")
