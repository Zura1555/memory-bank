ALTER TABLE model_attempts
  ADD COLUMN http_status smallint CHECK (http_status BETWEEN 100 AND 599),
  ADD COLUMN failure_phase text CHECK (failure_phase IN (
    'request', 'fetch', 'response_headers', 'response_body', 'response_validation', 'output_validation'
  )),
  ADD COLUMN failure_cause text CHECK (failure_cause IN (
    'deadline_exceeded', 'timeout', 'aborted', 'transport_error'
  ));
