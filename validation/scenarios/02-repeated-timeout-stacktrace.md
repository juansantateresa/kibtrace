# Scenario 02: Repeated Timeout with Stacktrace Clustering

## Description

An order service experiences repeated `SocketTimeoutException` when calling a
downstream payment service. The timeouts trigger a circuit breaker pattern:
open -> half-open -> re-test -> eventually recover.

## Expected Behavior from kibtrace

1. **Stacktrace grouping**: The repeated `SocketTimeoutException` stacktraces should
   be grouped into a single cluster rather than appearing as separate events.

2. **Timeout category**: The dominant hypothesis should be categorized as a
   timeout/connectivity issue pointing at the payment service dependency.

3. **Circuit breaker signal**: The circuit breaker WARN/ERROR messages should form
   their own cluster, supporting the timeout hypothesis.

4. **Recovery visible**: INFO-level events at the end (health check succeeded,
   circuit breaker closed) should cluster separately, showing the system recovered.

## Fixture

- File: `validation/fixtures/logs/repeated-timeout-stacktrace.log`
- Format: Plain text (traditional log4j-style)
- Events: ~30 lines including stacktraces across a 3-minute incident window

## Success Criteria

- [ ] Plain text parsed correctly (stacktrace lines grouped with their parent errors)
- [ ] Timeout errors clustered together (not one cluster per occurrence)
- [ ] Hypothesis identifies timeout/connectivity as the failure mode
- [ ] Stacktrace evidence referenced in supporting signals
- [ ] Circuit breaker events appear in clusters
