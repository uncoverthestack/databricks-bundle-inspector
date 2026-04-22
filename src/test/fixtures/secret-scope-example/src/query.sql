SELECT
    secret('jdbc-test', 'db-host')  AS db_host,
    secret('jdbc-test', 'db-user')  AS db_user,
    try_secret('jdbc-test', 'db-password') AS db_password
