select count(*) as row_count
from {{job.parameters.source_table}}
where date(tpep_pickup_datetime) <= date('{{job.parameters.processing_date}}')
